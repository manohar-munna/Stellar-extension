// Training-data recorder: every Gemini-decided step becomes a supervised
// example (sanitized frame + compact prompt -> Gemini's action) for
// fine-tuning the on-device model. Only what was already sent to Gemini is
// stored — sanitized JPEG, scrubbed text, tag-only actions — never raw frames
// or vault values. Data lives in this browser's IndexedDB until exported.

import { compactPrompt, compactAnswer } from "./local/train-format.js";
import { buildShortlist, choicePrompt } from "./local/planner.js";

const DB_NAME = "stellar-training";
let dbp = null;

function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("episodes", { keyPath: "id", autoIncrement: true });
      d.createObjectStore("examples", { keyPath: "id", autoIncrement: true }).createIndex("episode", "episode");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

const all = (store) => tx(store, "readonly", (s) => s.getAll());

export async function startEpisode(meta) {
  return tx("episodes", "readwrite", (s) => s.add({ ...meta, startedAt: Date.now(), outcome: null }));
}

export async function addExample(episode, ex) {
  const image = ex.image ? await (await fetch(ex.image)).blob() : null;
  return tx("examples", "readwrite", (s) => s.add({ ...ex, image, episode, at: Date.now() }));
}

export async function patchEpisode(id, patch) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("episodes", "readwrite");
    const s = t.objectStore("episodes");
    const g = s.get(id);
    g.onsuccess = () => g.result && s.put({ ...g.result, ...patch });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export const endEpisode = (id, outcome) => patchEpisode(id, { outcome, endedAt: Date.now() });

export async function clearTraining() {
  await tx("examples", "readwrite", (s) => s.clear());
  await tx("episodes", "readwrite", (s) => s.clear());
}

/** An episode is usable when it ended successfully (and, if checked, its ground truth matched). */
const usableEpisode = (e) => e.outcome?.ok && e.verified !== false;
/** A step is a usable label when the local gate allowed it (or the user approved) and it worked. */
const usableStep = (x) => x.decision?.action && (x.kind === "done" || (x.executed && x.resultOk));

export async function trainingStats() {
  const [eps, exs] = await Promise.all([all("episodes"), all("examples")]);
  const good = new Set(eps.filter(usableEpisode).map((e) => e.id));
  return {
    episodes: eps.length,
    successful: good.size,
    verified: eps.filter((e) => e.verified === true).length,
    examples: exs.length,
    usable: exs.filter((x) => good.has(x.episode) && usableStep(x)).length,
  };
}

// ------------------------------------------------------------------ zip
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal STORE-only zip writer (images are already JPEG-compressed). */
function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : enc.encode(f.data);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, p) => a + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

// --------------------------------------------------------------- export
export async function exportDataset({ onlyUsable = true } = {}) {
  const [eps, exs] = await Promise.all([all("episodes"), all("examples")]);
  const epById = new Map(eps.map((e) => [e.id, e]));
  const files = [];
  const steps = [];
  const full = [];
  const mcq = [];
  const stats = { episodes: eps.length, successfulEpisodes: 0, examples: exs.length, exported: 0, mcq: 0, shortlistHits: 0, shortlistMisses: 0, actions: {} };
  stats.successfulEpisodes = eps.filter(usableEpisode).length;

  for (const x of exs.sort((a, b) => a.episode - b.episode || a.step - b.step)) {
    const ep = epById.get(x.episode);
    const ok = ep && usableEpisode(ep) && usableStep(x);
    if (onlyUsable && !ok) continue;
    const id = `ep${String(x.episode).padStart(4, "0")}_s${String(x.step).padStart(2, "0")}`;
    const imgName = `images/${id}.jpg`;
    if (x.image) files.push({ name: imgName, data: new Uint8Array(await x.image.arrayBuffer()) });
    const answer = compactAnswer(x.decision.action);
    stats.actions[x.decision.action.type] = (stats.actions[x.decision.action.type] || 0) + 1;
    const ctx = { task: x.task, host: x.host, elements: x.elements, history: x.history, vaultTags: x.vaultTags, hiddenTags: x.hiddenTags };

    steps.push({ id, image: imgName, episode: x.episode, step: x.step, source: ep?.source || "user", verified: ep?.verified ?? null, ...ctx, model: x.model, observation: x.decision.observation, thought: x.decision.thought, action: x.decision.action, verdict: x.verdict, resultOk: x.resultOk });
    if (answer) {
      full.push({ id, image: imgName, conversations: [{ from: "human", value: `<image>\n${compactPrompt(ctx)}` }, { from: "gpt", value: answer }] });
      stats.exported++;
    }

    // Multiple-choice version, exactly as the on-device planner asks it.
    const { shortlist, canFinish } = buildShortlist({ task: x.task, elements: x.elements, history: x.history.map((t) => ({ text: t })), vaultTags: x.vaultTags });
    let label = null;
    if (x.decision.action.type === "done" && canFinish) label = shortlist.length + 1;
    else {
      const k = shortlist.findIndex((c) => c.e.tag === x.decision.action.target);
      if (k >= 0) label = k + 1;
    }
    if (x.decision.action.target || x.decision.action.type === "done") label ? stats.shortlistHits++ : stats.shortlistMisses++;
    if (label) {
      mcq.push({ id: `${id}_mcq`, image: imgName, conversations: [{ from: "human", value: `<image>\n${choicePrompt({ task: x.task, history: x.history.map((t) => ({ text: t })), shortlist, canFinish })}` }, { from: "gpt", value: String(label) }] });
      stats.mcq++;
    }
  }

  const hitRate = stats.shortlistHits + stats.shortlistMisses ? (stats.shortlistHits / (stats.shortlistHits + stats.shortlistMisses)) * 100 : 0;
  files.push({ name: "steps.jsonl", data: steps.map((s) => JSON.stringify(s)).join("\n") + "\n" });
  files.push({ name: "llava_full.json", data: JSON.stringify(full, null, 1) });
  files.push({ name: "llava_mcq.json", data: JSON.stringify(mcq, null, 1) });
  files.push({ name: "stats.json", data: JSON.stringify({ ...stats, shortlistHitRate: +hitRate.toFixed(1), exportedAt: new Date().toISOString() }, null, 2) });
  files.push({ name: "README.md", data: datasetReadme(stats, hitRate) });
  return { blob: zip(files), stats: { ...stats, shortlistHitRate: +hitRate.toFixed(1) } };
}

function datasetReadme(stats, hitRate) {
  return `# Stellar on-device agent dataset

Distilled from Gemini runs of the Stellar extension (teacher = Gemini, student = FastVLM-0.5B).
Every image is the **sanitized** frame that was sent to Gemini: private data is masked with
semantic tags and interactive elements carry Set-of-Marks labels. Actions use tags such as
[VAULT_NAME]; no real private values are stored.

Exported: ${stats.exported} examples (${stats.mcq} multiple-choice) from ${stats.successfulEpisodes} successful episodes.
Planner shortlist contained Gemini's choice in ${hitRate.toFixed(1)}% of steps.
Action mix: ${Object.entries(stats.actions).map(([k, v]) => `${k} ${v}`).join(", ")}

## Files
- \`images/*.jpg\` — sanitized frames.
- \`llava_full.json\` — LLaVA-style records: compact prompt (goal, element list, vault tags, history) -> one-line action
  (\`click TAG\`, \`type TAG TEXT\`, \`select TAG OPTION\`, \`done ANSWER\`, …). Train this to replace the heuristic planner.
- \`llava_mcq.json\` — the on-device planner's multiple-choice prompt -> option number. Train this to improve the
  current hybrid planner without changing its code.
- \`steps.jsonl\` — full context per step (elements with options/form/rect, history, Gemini observation/thought,
  validator verdict, execution result) for re-formatting.

Prompts are produced by \`sidepanel/local/train-format.js\` and \`sidepanel/local/planner.js\`, the same code the
extension uses at run time.

## Licences
Labels are Gemini outputs — check the Gemini API terms before using them to train models. FastVLM weights are
released under Apple's model licence; check it for your use.
`;
}
