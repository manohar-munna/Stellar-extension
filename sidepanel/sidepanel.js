// Side panel UI: renders each pipeline stage as it happens and wires settings.
// All page/model-derived strings go through textContent (never innerHTML).

import { StellarAgent, describeAction } from "./agent.js";
import { loadSettings, saveSettings, DEFAULTS } from "./settings.js";
import { listModels } from "./gemini.js";
import { CATEGORY_COLORS } from "./privacy.js";
import { loadLocalModel, onLocalState, isLocalModelCached, localState, LOCAL_MODEL, configureAutoUnload } from "./local/vlm.js";
import { extractFromFile, mergeIntoVault, VAULT_FIELDS } from "./vault-import.js";

const $ = (sel) => document.querySelector(sel);
const STAGES = ["capture", "detect", "redact", "send", "reason", "validate", "execute"];

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const feed = $("#feed");
const statusLine = $("#statusLine");
const runBtn = $("#runBtn");
const snapBtn = $("#snapBtn");
const stopBtn = $("#stopBtn");
const taskInput = $("#task");

let pending = [];

// ------------------------------------------------------------- utilities

// ------------------------------------------------------- smooth follow
// While a run is on screen the panel glides to each new card instead of
// jumping. If the user scrolls up to read, following pauses until they press
// "Follow live" or scroll back to the bottom.

const follow = { on: true, raf: 0, gliding: false, target: null };
const followBtn = document.getElementById("followBtn");

function atBottom() {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40;
}

function stickyOffset() {
  const bar = document.getElementById("runbar");
  return (bar && !bar.hidden ? bar.getBoundingClientRect().height : 0) + 10;
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Ease the window so `node`'s top settles just below the sticky tab bar.
 *  The target is re-measured every frame, so folding steps don't cause jumps. */
function glideTo(node, duration = 850) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) duration = 1;
  if (!node?.isConnected || !node.offsetParent) return;
  cancelAnimationFrame(follow.raf);
  follow.target = node;
  follow.gliding = true;
  const startY = window.scrollY;
  const t0 = performance.now();
  const frame = (now) => {
    if (follow.target !== node) return;
    const maxY = document.documentElement.scrollHeight - window.innerHeight;
    // Tall cards: align their top; short ones: keep them fully in view.
    const r = node.getBoundingClientRect();
    let goal = window.scrollY + r.top - stickyOffset();
    if (r.height < window.innerHeight * 0.6) goal = Math.max(goal - (window.innerHeight - stickyOffset() - r.height) * 0.35, 0);
    goal = Math.min(Math.max(goal, 0), Math.max(maxY, 0));
    const t = Math.min(1, (now - t0) / duration);
    window.scrollTo(0, startY + (goal - startY) * easeInOut(t));
    if (t < 1) follow.raf = requestAnimationFrame(frame);
    else follow.gliding = false;
  };
  follow.raf = requestAnimationFrame(frame);
}

function setFollow(on) {
  follow.on = on;
  followBtn.hidden = on || !activeRun;
  if (!on) {
    cancelAnimationFrame(follow.raf);
    follow.gliding = false;
  }
}

// Any deliberate user scroll upward pauses following; reaching the bottom resumes it.
window.addEventListener(
  "wheel",
  (e) => {
    if (e.deltaY < 0 && activeRun) setFollow(false);
    else if (atBottom() && !follow.on) setFollow(true);
  },
  { passive: true }
);
window.addEventListener("keydown", (e) => {
  if (["PageUp", "ArrowUp", "Home"].includes(e.key) && activeRun && !e.target.closest("textarea, input")) setFollow(false);
});
window.addEventListener("touchmove", () => activeRun && setFollow(false), { passive: true });
followBtn.addEventListener("click", () => {
  setFollow(true);
  const run = activeRun;
  const last = run?.steps[run.steps.length - 1];
  glideTo(last?.body.lastElementChild || last?.el || run?.el);
});

function append(parent, node) {
  parent.append(node);
  if (follow.on && node.offsetParent) {
    node.classList.add("fresh");
    setTimeout(() => node.classList.remove("fresh"), 1600);
    glideTo(node);
  }
}

// Guided pace: hold each stage on screen for a moment so people can follow.
const DWELL_MS = { capture: 1100, detect: 1400, redact: 1600, send: 1200, reason: 1500, validate: 1000, execute: 900 };
const dwellers = new Set();

function dwell(run, stage) {
  if (run?.pace !== "guided" || !DWELL_MS[stage]) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      dwellers.delete(done);
      resolve();
    };
    const t = setTimeout(done, DWELL_MS[stage]);
    dwellers.add(done);
  });
}

function tagChip(tag, category) {
  const color = CATEGORY_COLORS[category] || "#94a3b8";
  return h("span", { class: "tag", style: { color, borderColor: color + "66", background: color + "14" } }, `[${tag}]`);
}

function usageText(u) {
  if (!u) return "";
  const parts = [`${u.promptTokenCount ?? "?"} in`, `${u.candidatesTokenCount ?? 0} out`];
  if (u.thoughtsTokenCount) parts.push(`${u.thoughtsTokenCount} thinking`);
  return parts.join(" · ") + " tokens";
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function uniqueRegions(regions) {
  return [...new Map(regions.map((r) => [r.tag, r])).values()];
}

/** Copy of card data safe for export: no raw frames, no private values. */
function exportable(stage, data) {
  const d = { ...data };
  if (stage === "capture" || stage === "detect") delete d.image;
  if (d.regions) d.regions = d.regions.map(({ value, ...r }) => r);
  return d;
}

// --------------------------------------------------------------- renderers

function card({ title, badge, badgeText, meta, cloud }, ...body) {
  return h(
    "article",
    { class: `card${cloud ? " cloud" : ""}` },
    h("div", { class: "card-h" }, h("span", { class: `badge ${badge}` }, badgeText), h("span", { class: "title" }, title), meta ? h("span", { class: "meta" }, meta) : null),
    h("div", { class: "card-b" }, ...body)
  );
}

function shot(src, raw) {
  return h("img", { class: `shot${raw ? " raw" : ""}`, src, alt: raw ? "Raw capture (local only)" : "Sanitized frame" });
}

const RENDER = {
  capture(d) {
    return card(
      { title: "Capture", badge: "local", badgeText: "on-device", meta: `${d.ms} ms` },
      shot(d.image, true),
      h(
        "dl",
        { class: "kv" },
        h("dt", {}, "Page"),
        h("dd", { title: d.url }, hostOf(d.url)),
        h("dt", {}, "Frame"),
        h("dd", {}, `${d.size} (viewport ${d.viewport.w}×${d.viewport.h} @${d.viewport.dpr}x)`),
        h("dt", {}, "Elements"),
        h("dd", {}, `${d.elementCount} interactive elements tagged`)
      ),
      h("div", { class: "note" }, "Raw frame stays in this panel. It is never exported.")
    );
  },

  detect(d) {
    const vision = d.mode === "vision";
    const uniq = uniqueRegions(d.regions);
    const body = [
      h(
        "div",
        { class: "stats" },
        h("div", { class: "stat" }, h("b", {}, d.domCount), h("span", {}, "DOM hits (local)")),
        h("div", { class: "stat" }, h("b", {}, d.faceMeta ? d.faceMeta.count : "—"), h("span", {}, "Faces (on-device)")),
        vision ? h("div", { class: "stat" }, h("b", {}, d.visionCount), h("span", {}, "Cloud vision hits")) : null,
        h("div", { class: "stat" }, h("b", {}, uniq.length), h("span", {}, "semantic tags"))
      ),
      shot(d.image, true),
    ];
    if (d.regions.length) {
      body.push(
        h(
          "table",
          { class: "regions" },
          h(
            "tbody",
            {},
            d.regions.map((r) =>
              h("tr", {}, h("td", {}, tagChip(r.tag, r.category)), h("td", { class: "src" }, r.source), h("td", { class: "det" }, r.detail || r.category.toLowerCase()))
            )
          )
        )
      );
    } else {
      body.push(h("div", { class: "note" }, "No credentials or personal data detected on this frame."));
    }
    if (d.visionMeta) {
      body.push(
        h(
          "div",
          { class: "note warn" },
          `Vision detector: ${d.visionMeta.model} · ${d.visionMeta.latencyMs} ms · ${usageText(d.visionMeta.usage)}` +
            `${d.visionMeta.keyCount > 1 ? ` · key ${d.visionMeta.keyIndex}/${d.visionMeta.keyCount}` : ""}. ` +
            "Comparison mode: the unredacted frame was sent to the cloud detector. Switch PII detection to On-device in Settings to keep it local."
        )
      );
    }
    if (d.faceMeta) body.push(h("div", { class: "note" }, `On-device face detector (BlazeFace): ${d.faceMeta.count} face${d.faceMeta.count === 1 ? "" : "s"} in ${d.faceMeta.ms} ms · nothing sent`));
    return card({ title: "Detect", badge: vision ? "mixed" : "local", badgeText: vision ? "local + cloud vision" : "on-device", meta: `${d.ms} ms` }, ...body);
  },

  redact(d) {
    const uniq = uniqueRegions(d.regions);
    return card(
      { title: "Redact → semantic tags", badge: "local", badgeText: "on-device", meta: `${d.ms} ms` },
      shot(d.image, false),
      uniq.length ? h("div", { class: "tags" }, uniq.map((r) => tagChip(r.tag, r.category))) : h("div", { class: "note" }, "Nothing to mask."),
      h("div", { class: "note" }, `${d.elementCount} elements labelled for actions · faces blurred, credentials blacked out, other PII masked`)
    );
  },

  send(d) {
    if (d.keptLocal) {
      return card(
        { title: "Kept on device", badge: "local", badgeText: "on-device" },
        h("div", { class: "leak ok" }, "✓ Local-first: the on-device model is confident about this step — nothing is sent to Gemini"),
        h("details", {}, h("summary", {}, "Prompt Gemini would have received"), h("pre", {}, d.prompt))
      );
    }
    if (d.localOnly) {
      return card(
        { title: "Kept on device", badge: "local", badgeText: "on-device", meta: `${Math.round(d.bytes / 1024)} KB` },
        h("div", { class: "leak ok" }, "✓ On-device mode — the sanitized frame and prompt stay in this browser"),
        h("details", {}, h("summary", {}, "Prompt the cloud model would have received"), h("pre", {}, d.prompt))
      );
    }
    const leak = d.leaks.length
      ? h("div", { class: "leak bad" }, `✗ Leak check failed: ${d.leaks.map((t) => `[${t}]`).join(", ")} in outbound text — request blocked`)
      : h("div", { class: "leak ok" }, `✓ Leak check passed — 0 of ${d.secretCount} locally-known private values in the outbound text`);
    return card(
      {
        title: d.snapshot ? "Outbound payload (preview — not sent)" : "Send sanitized payload",
        badge: d.snapshot ? "mixed" : "cloud",
        badgeText: d.snapshot ? "preview" : "→ cloud",
        meta: `${Math.round(d.bytes / 1024)} KB`,
        cloud: !d.snapshot,
      },
      leak,
      h(
        "div",
        { class: "stats" },
        h("div", { class: "stat" }, h("b", {}, `${Math.round(d.bytes / 1024)} KB`), h("span", {}, "sanitized JPEG")),
        h("div", { class: "stat" }, h("b", {}, d.prompt.length), h("span", {}, "prompt chars")),
        h("div", { class: "stat" }, h("b", {}, d.leaks.length), h("span", {}, "raw PII in text"))
      ),
      h("details", {}, h("summary", {}, "Request body (JSON)"), h("pre", {}, JSON.stringify(d.payload, null, 2))),
      h("details", {}, h("summary", {}, "Prompt text"), h("pre", {}, d.prompt))
    );
  },

  reason(d) {
    const a = d.decision?.action || {};
    const local = !!d.local;
    return card(
      {
        title: local ? (d.localFirst ? "Reason (on-device, confident)" : d.localOnly ? "Reason (on-device)" : "Reason (on-device backup)") : "Reason",
        badge: local ? "local" : "cloud",
        badgeText: local ? "on-device" : "cloud",
        meta: `${d.latencyMs} ms`,
        cloud: !local,
      },
      d.fallback ? h("div", { class: "note warn" }, `Gemini failed (${d.fallback.slice(0, 160)}) — ${LOCAL_MODEL.name} decided this step on your device.`) : null,
      d.whyCloud ? h("div", { class: "note" }, `On-device model wasn't sure: ${d.whyCloud} → asked Gemini.`) : null,
      h("div", { class: "thought" }, h("b", {}, "Sees: "), d.decision?.observation || "—"),
      h("div", { class: "thought" }, h("b", {}, local ? "Considered: " : "Plans: "), d.decision?.thought || "—"),
      h("div", {}, h("span", { class: "action-pill" }, "⇢ ", describeAction(a))),
      a.final_answer && a.type !== "done" && a.type !== "ask_user" ? h("div", { class: "note" }, a.final_answer) : null,
      h(
        "div",
        { class: "note" },
        local ? `${d.model} · on-device (${localState.device || "?"}) · nothing sent` : `${d.model} · ${usageText(d.usage)}${d.keyCount > 1 ? ` · key ${d.keyIndex}/${d.keyCount}` : ""}`
      ),
      h("details", {}, h("summary", {}, "Model response (JSON)"), h("pre", {}, JSON.stringify(d.decision, null, 2)))
    );
  },

  validate(d) {
    const icon = { pass: "✓", warn: "!", confirm: "?", block: "✗", auto: "✓" };
    return card(
      { title: "Validate (local gate)", badge: "local", badgeText: "on-device" },
      h("div", {}, h("span", { class: `verdict ${d.verdict}` }, d.pending ? "needs approval" : d.verdict), " ", h("span", { class: "action-pill" }, d.summary)),
      h(
        "ul",
        { class: "checks" },
        d.checks.map((c) => h("li", { class: c.level }, h("span", { class: "i" }, icon[c.level]), h("span", {}, c.label)))
      )
    );
  },

  execute(d) {
    if (d.skipped) {
      return card({ title: "Execute", badge: "local", badgeText: "on-device" }, h("div", { class: "result skip" }, `⏸ Not executed — ${d.detail}`));
    }
    return card(
      { title: "Execute", badge: "local", badgeText: "on-device", meta: `${d.ms} ms` },
      h("div", { class: `result ${d.ok ? "ok" : "bad"}` }, `${d.ok ? "✓" : "✗"} ${d.detail}`),
      d.userNote ? h("div", { class: "note" }, d.userNote) : null
    );
  },
};

// ---------------------------------------------------------------- runs

// Static description of each stage for the stage bars and placeholders.
const STAGE_META = {
  capture: { zone: "local", zn: "device", doing: "Capturing the visible tab and tagging elements…" },
  detect: { zone: "local", zn: "device", doing: "Scanning for credentials & personal data…" },
  redact: { zone: "local", zn: "device", doing: "Masking private regions with semantic tags…" },
  send: { zone: "cloud", zn: "to cloud", doing: "Building the sanitized payload and running the leak check…" },
  reason: { zone: "cloud", zn: "cloud", doing: "Gemini is choosing the next action…" },
  validate: { zone: "local", zn: "device", doing: "Checking the proposed action locally…" },
  execute: { zone: "local", zn: "device", doing: "Performing the action in the page…" },
};

const runs = [];
let activeRun = null; // the run the agent is executing
let selectedRun = null; // the run on screen
let runSeq = 0;

const runTabs = $("#runTabs");
const runbar = $("#runbar");

/** Zone of a stage for a given run (Detect is mixed when the vision detector is on). */
function zoneOf(run, stage) {
  if (stage === "detect" && run?.vision) return { zone: "mixed", zn: "+ cloud" };
  if (stage === "detect") return { zone: "local", zn: "device" };
  if (stage === "send" && run?.snapshot) return { zone: "local", zn: "preview" };
  return STAGE_META[stage];
}

function makeRun({ task, snapshot, settings, maxSteps }) {
  const id = ++runSeq;
  const title = snapshot ? `Snapshot ${id}` : `Task ${id}`;
  const run = {
    id,
    title,
    task,
    snapshot,
    vision: settings.detector === "vision",
    pace: settings.pace || "guided",
    maxSteps,
    status: "running",
    stage: null,
    steps: [],
    result: null,
    t0: performance.now(),
    stats: { tags: new Set(), bytes: 0, leaks: 0 },
    log: {
      task,
      mode: snapshot ? "snapshot" : "agent",
      startedAt: new Date().toISOString(),
      detector: settings.detector,
      reasonModel: settings.reasonModel,
      steps: [],
    },
  };

  run.el = h(
    "section",
    { class: "run", "data-run": id },
    h(
      "div",
      { class: "run-h" },
      h("div", { class: "lbl" }, snapshot ? "Snapshot" : `Task ${id} · ${settings.runMode === "autopilot" ? "Autopilot" : "Safe mode"} · ${{ localfirst: "Local-first", auto: "Gemini-first", always: "On-device only", off: "Gemini only" }[settings.localBackup] || ""}`),
      h("div", { class: "task" }, snapshot ? task || "Capture → Detect → Redact preview" : task),
      (run.statsEl = h("div", { class: "run-stats" }))
    ),
    h(
      "div",
      { class: "run-tools" },
      h("button", { class: "link", onclick: () => setAllCollapsed(run, false) }, "Expand all"),
      h("button", { class: "link", onclick: () => setAllCollapsed(run, true) }, "Collapse all")
    )
  );
  feed.append(run.el);

  run.dot = h("span", { class: "sdot running" });
  run.tab = h(
    "button",
    { class: "runtab", role: "tab", title: snapshot ? "Privacy snapshot" : task, onclick: () => selectRun(run) },
    run.dot,
    h("span", { class: "t" }, title),
    h(
      "span",
      {
        class: "x",
        title: "Close",
        onclick: (e) => {
          e.stopPropagation();
          closeRun(run);
        },
      },
      "×"
    )
  );
  runTabs.append(run.tab);
  runbar.hidden = false;
  runs.push(run);
  return run;
}

function selectRun(run) {
  selectedRun = run;
  for (const r of runs) {
    r.el.classList.toggle("sel", r === run);
    r.tab.classList.toggle("sel", r === run);
  }
  // Scroll only the tab strip sideways; never move the page vertically.
  if (run) {
    const strip = run.tab.parentElement;
    const l = run.tab.offsetLeft - strip.offsetLeft;
    if (l < strip.scrollLeft || l + run.tab.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: l - 12, behavior: "smooth" });
  }
}

function closeRun(run) {
  if (run === activeRun) return; // can't close a running task
  run.el.remove();
  run.tab.remove();
  runs.splice(runs.indexOf(run), 1);
  if (selectedRun === run) selectRun(runs[runs.length - 1] || null);
  if (!runs.length) runbar.hidden = true;
}

function setRunStatus(run, status) {
  run.status = status;
  run.dot.className = `sdot ${status}`;
  updateRunStats(run);
}

function setAllCollapsed(run, collapsed) {
  for (const s of run.steps) s.el.classList.toggle("collapsed", collapsed);
}

// ---------------------------------------------------------------- steps
// Each step shows a brief (stage bar + what was hidden / sent / seen) that
// stays visible when the step is folded; the full stage cards sit below it.

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

function updateRunStats(run) {
  const n = run.steps.length;
  const secs = ((performance.now() - run.t0) / 1000).toFixed(1);
  const parts = [
    run.snapshot ? "snapshot" : `${n} step${n === 1 ? "" : "s"}`,
    `${run.stats.tags.size} private item${run.stats.tags.size === 1 ? "" : "s"} hidden`,
    run.stats.bytes ? `${kb(run.stats.bytes)} sanitized sent` : "nothing sent",
    `${run.stats.leaks} leak${run.stats.leaks === 1 ? "" : "s"}`,
    `${secs}s`,
  ];
  run.statsEl.textContent = parts.join(" · ");
}

function makeStep(run, n) {
  const step = { n, t0: performance.now(), stages: new Map(), action: "", result: null, rows: {}, zones: {} };
  step.sum = h("span", { class: "sum" }, h("span", { class: "spinner sm" }), "Working…");
  step.time = h("span", { class: "time" });
  step.bar = h("div", { class: "stagebar" });
  step.stageLbl = h("span", { class: "stage-lbl" });
  step.brief = h("div", { class: "brief" }, h("div", { class: "stage-row" }, step.bar, step.stageLbl));
  step.body = h("div", { class: "step-inner" });
  step.fold = h("div", { class: "step-body" }, step.body);
  step.el = h(
    "section",
    { class: "step live" },
    h(
      "button",
      { class: "step-h", onclick: () => step.el.classList.toggle("collapsed") },
      h("span", { class: "n" }, run.snapshot ? "Snapshot" : `Step ${n}`),
      step.sum,
      step.time,
      h("span", { class: "chev" }, "▾")
    ),
    step.brief,
    step.fold
  );
  renderStageBar(run, step);
  return step;
}

/** Seven segments, coloured by where each stage runs; click one to open its card. */
function renderStageBar(run, step) {
  const live = step.el.classList.contains("live") && run.stage;
  step.bar.replaceChildren(
    ...STAGES.map((s) => {
      const z = step.zones[s] ? { zone: step.zones[s], zn: "device" } : zoneOf(run, s);
      const state = step.stages.get(s) || (live && run.stage === s ? "active" : "");
      return h("button", {
        class: `seg zone-${z.zone} ${state}`,
        title: `${STAGES.indexOf(s) + 1}. ${cap(s)} — ${z.zone === "cloud" ? "cloud, sanitized data only" : z.zone === "mixed" ? "on-device rules + Gemini vision detector" : "on this device"}`,
        onclick: (e) => {
          e.stopPropagation();
          jumpTo(step, s);
        },
      });
    })
  );
  if (live) {
    const z = zoneOf(run, run.stage);
    step.stageLbl.className = `stage-lbl zone-${z.zone}`;
    step.stageLbl.textContent = `${STAGES.indexOf(run.stage) + 1}/7 ${cap(run.stage)} · ${z.zn}`;
  } else {
    step.stageLbl.className = "stage-lbl";
    step.stageLbl.textContent = "";
  }
}

function jumpTo(step, stage) {
  step.el.classList.remove("collapsed");
  const target = step.body.querySelector(`.card[data-stage="${stage}"]`) || step.body;
  setTimeout(() => glideTo(target, 700), 50); // let the fold open first
}

/** Create or update one line of the step brief (hidden / sent / saw). */
function setBrief(step, key, kind, label, ...content) {
  const row = h("div", { class: `bl bl-${kind}` }, h("span", { class: "bl-k" }, label), h("span", { class: "bl-v" }, ...content));
  if (step.rows[key]) step.rows[key].replaceWith(row);
  else step.brief.append(row);
  step.rows[key] = row;
}

function tagChips(regions, max = 6) {
  const uniq = uniqueRegions(regions);
  const chips = uniq.slice(0, max).map((r) => tagChip(r.tag, r.category));
  if (uniq.length > max) chips.push(h("span", { class: "more" }, `+${uniq.length - max}`));
  return chips;
}

function summarizeStep(run, step, { collapse }) {
  step.el.classList.remove("live");
  const r = step.result;
  const mark = !r ? null : r.kind === "ok" ? h("span", { class: "ok" }, "✓ ") : r.kind === "skip" ? h("span", { class: "skip" }, "⏸ ") : h("span", { class: "bad" }, "✗ ");
  step.sum.replaceChildren(...[mark, step.action || (r?.text ?? "—")].filter(Boolean));
  step.sum.title = [step.action, r?.text].filter(Boolean).join(" → ");
  step.time.textContent = `${((performance.now() - step.t0) / 1000).toFixed(1)}s`;
  renderStageBar(run, step);
  updateRunStats(run);
  if (collapse) step.el.classList.add("collapsed");
}

function removePlaceholders(run) {
  run?.el.querySelectorAll(".card.pending").forEach((n) => n.remove());
}

// ---------------------------------------------------------------------- ui

const ui = {
  runStarted({ task, snapshot, settings, maxSteps }) {
    $("#intro")?.remove();
    activeRun = makeRun({ task, snapshot, settings, maxSteps });
    selectRun(activeRun);
    setFollow(true);
    setRunning(true);
    this.status(snapshot ? "Taking a privacy snapshot…" : "Starting…");
  },

  note(text) {
    const run = activeRun;
    if (!run) return this.status(text);
    const step = run.steps[run.steps.length - 1];
    append(step ? step.body : run.el, h("div", { class: "run-note" }, text));
  },

  beginStep(n) {
    const run = activeRun;
    const prev = run.steps[run.steps.length - 1];
    if (prev) summarizeStep(run, prev, { collapse: true });
    const step = makeStep(run, n);
    run.steps.push(step);
    run.log.steps.push({ step: n, cards: [] });
    append(run.el, step.el);
    updateRunStats(run);
    return step;
  },

  setStage(stage) {
    const run = activeRun;
    if (!run) return;
    run.stage = stage;
    removePlaceholders(run);
    const step = run.steps[run.steps.length - 1];
    if (stage && step) {
      const z = zoneOf(run, stage);
      const ph = h(
        "article",
        { class: `card pending zone-${z.zone}`, "data-stage": stage },
        h(
          "div",
          { class: "card-h" },
          h("span", { class: "num" }, STAGES.indexOf(stage) + 1),
          h("span", { class: `badge ${z.zone === "mixed" ? "mixed" : z.zone}` }, z.zone === "cloud" ? "cloud" : z.zone === "mixed" ? "local + vision" : "on-device"),
          h("span", { class: "title" }, stage[0].toUpperCase() + stage.slice(1))
        ),
        h("div", { class: "card-b" }, h("span", { class: "spinner" }), STAGE_META[stage].doing)
      );
      append(step.body, ph);
    }
    if (step) renderStageBar(run, step);
  },

  card(S, stage, data) {
    const run = activeRun;
    const node = RENDER[stage](data);
    if (data.local || data.localOnly) S.zones[stage] = "local";
    node.classList.add(`zone-${S.zones[stage] || zoneOf(run, stage).zone}`);
    node.dataset.stage = stage;
    node.querySelector(".card-h").prepend(h("span", { class: "num" }, STAGES.indexOf(stage) + 1));
    S.lastCard = node;
    const ph = S.body.querySelector(`.card.pending[data-stage="${stage}"]`);
    if (ph) ph.replaceWith(node);
    else append(S.body, node);

    // Track what the step did for its summary and stage bar.
    S.stages.set(stage, data.skipped ? "skipped" : data.verdict === "block" ? "blocked" : "done");
    if (stage === "validate") S.action = data.summary;
    if (stage === "reason" && ["done", "ask_user"].includes(data.decision?.action?.type)) {
      S.action = describeAction(data.decision.action);
      S.stages.set("validate", "skipped");
      S.stages.set("execute", "skipped");
    }
    if (stage === "execute") S.result = data.skipped ? { kind: "skip", text: data.detail } : { kind: data.ok ? "ok" : "bad", text: data.detail };
    if (stage === "send" && data.snapshot) {
      S.action = "privacy snapshot";
      S.result = { kind: "ok", text: "nothing sent for reasoning" };
      for (const s of ["reason", "validate", "execute"]) S.stages.set(s, "skipped");
    }
    this.brief(run, S, stage, data);
    renderStageBar(run, S);
    run.log.steps[run.log.steps.length - 1].cards.push({ stage, ...exportable(stage, data) });
    if (ph && follow.on) glideTo(node);
    return data.pending ? Promise.resolve() : dwell(run, stage);
  },

  /** Fill the step's short brief from a stage's data. */
  brief(run, S, stage, data) {
    if (stage === "detect") {
      const uniq = uniqueRegions(data.regions);
      uniq.forEach((r) => run.stats.tags.add(r.tag));
      const how = data.mode === "vision" ? "on-device + cloud vision" : "on-device rules + face detection";
      if (uniq.length) setBrief(S, "hidden", "local", "Hidden", `${uniq.length} private item${uniq.length === 1 ? "" : "s"}`, h("span", { class: "chips" }, tagChips(data.regions)));
      else setBrief(S, "hidden", "local", "Hidden", h("span", { class: "dim" }, `nothing private on screen (${how})`));
    }
    if (stage === "send" && data.keptLocal) {
      setBrief(S, "sent", "local", "Sent", h("span", { class: "dim" }, "nothing — the on-device model was confident"));
    } else if (stage === "send" && data.localOnly) {
      setBrief(S, "sent", "local", "Sent", h("span", { class: "dim" }, "nothing — on-device mode, the frame stays in this browser"));
    } else if (stage === "send") {
      if (data.snapshot) {
        setBrief(S, "sent", "local", "Sent", h("span", { class: "dim" }, "nothing — snapshot preview stays on this device"));
      } else {
        S.sendInfo = `${kb(data.bytes)} sanitized frame + ${data.prompt.length.toLocaleString()} chars`;
        S.leakOk = !data.leaks.length;
        run.stats.bytes += data.bytes;
        run.stats.leaks += data.leaks.length;
        setBrief(S, "sent", "cloud", "Sent", S.sendInfo, h("span", { class: `pill ${S.leakOk ? "ok" : "bad"}` }, S.leakOk ? "✓ 0 leaks" : "✗ blocked"));
      }
    }
    if (stage === "reason" && data.local) {
      if (data.localFirst) setBrief(S, "sent", "local", "Sent", h("span", { class: "dim" }, `nothing — decided on-device by ${data.model}`));
      else if (!data.localOnly) setBrief(S, "sent", "local", "Sent", h("span", { class: "dim" }, `Gemini failed → decided on-device by ${data.model}`));
      if (data.decision?.observation) setBrief(S, "saw", "muted", "Saw", data.decision.observation);
    } else if (stage === "reason") {
      setBrief(S, "sent", "cloud", "Sent", `to ${data.model}: ${S.sendInfo || ""}`, h("span", { class: `pill ${S.leakOk === false ? "bad" : "ok"}` }, S.leakOk === false ? "✗ blocked" : "✓ 0 leaks"));
      if (data.decision?.observation) setBrief(S, "saw", "muted", "Saw", data.decision.observation);
    }
    updateRunStats(run);
  },

  status(text) {
    statusLine.textContent = text;
    statusLine.classList.toggle("live", !!text);
  },

  confirm(S, reason) {
    const run = activeRun;
    setRunStatus(run, "waiting");
    return new Promise((resolve) => {
      const box = h(
        "div",
        { class: "confirm-box" },
        h("div", {}, h("b", {}, "Approval needed: "), reason),
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn ok", onclick: () => done(true) }, "Approve"),
          h("button", { class: "btn danger", onclick: () => done(false) }, "Reject")
        )
      );
      const done = (v) => {
        box.replaceWith(h("div", { class: `note ${v ? "" : "warn"}` }, v ? "✓ Approved by you" : "✗ Rejected by you"));
        pending = pending.filter((p) => p !== cancel);
        if (run.status === "waiting") setRunStatus(run, "running");
        resolve(v);
      };
      const cancel = () => done(false);
      pending.push(cancel);
      if (selectedRun !== run) selectRun(run);
      S.el.classList.remove("collapsed");
      (S.lastCard?.querySelector(".card-b") || S.body).append(box);
      if (follow.on) glideTo(box);
      this.status("Waiting for your approval…");
    });
  },

  ask(S, question) {
    const run = activeRun;
    setRunStatus(run, "waiting");
    return new Promise((resolve) => {
      const input = h("textarea", { rows: 2, placeholder: "Your answer…" });
      const box = card(
        { title: "Agent asks", badge: "cloud", badgeText: "question", cloud: true },
        h("div", { class: "ask-box" }, h("div", {}, question), input),
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn primary", onclick: () => done(input.value.trim() || "(no answer)") }, "Reply"),
          h("button", { class: "btn ghost", onclick: () => done("Done — I've completed it myself. Continue.") }, "Done, continue"),
          h("button", { class: "btn danger", onclick: () => done(null) }, "Stop")
        )
      );
      const done = (v) => {
        box.querySelector(".row")?.remove();
        input.disabled = true;
        pending = pending.filter((p) => p !== cancel);
        if (run.status === "waiting") setRunStatus(run, "running");
        resolve(v);
      };
      const cancel = () => done(null);
      pending.push(cancel);
      if (selectedRun !== run) selectRun(run);
      append(S.body, box);
      input.focus();
      this.status("The agent is waiting for your answer…");
    });
  },

  handoff(S, kind) {
    const run = activeRun;
    setRunStatus(run, "waiting");
    S.action = `human verification — ${kind}`;
    setBrief(S, "sent", "local", "Sent", h("span", { class: "dim" }, `nothing — paused for you to complete the ${kind}`));
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const live = h("div", { class: "watch" }, h("span", { class: "spinner" }), "Watching the tab — resumes automatically once the check is cleared…");
    const buttons = h(
      "div",
      { class: "row" },
      h("button", { class: "btn ok", onclick: () => finish("manual") }, "Continue"),
      h("button", { class: "btn danger", onclick: () => finish("stop") }, "Stop")
    );
    const node = card(
      { title: "Human verification needed", badge: "mixed", badgeText: "you" },
      h("div", {}, h("b", {}, kind), " is on the page. Stellar doesn't solve CAPTCHAs or bot checks — please complete it yourself in the tab."),
      h("div", { class: "note" }, "No check on the page? Click Continue — Stellar won't ask about it again during this task."),
      live,
      buttons
    );
    node.classList.add("zone-mixed", "handoff");
    node.dataset.stage = "handoff";
    let finished = false;
    const finish = (v) => {
      if (finished) return;
      finished = true;
      pending = pending.filter((p) => p !== cancel);
      const msg = { auto: "✓ Check cleared — resuming", manual: "✓ You marked it done — resuming", stop: "✗ Stopped", timeout: "✗ Timed out" }[v];
      live.replaceWith(h("div", { class: `note ${v === "auto" || v === "manual" ? "" : "warn"}` }, msg));
      buttons.remove();
      S.result = v === "auto" || v === "manual" ? { kind: "ok", text: "completed by you" } : { kind: "bad", text: msg };
      for (const s of STAGES.slice(1)) S.stages.set(s, "skipped");
      renderStageBar(run, S);
      if (run.status === "waiting") setRunStatus(run, "running");
      resolveDone(v);
    };
    const cancel = () => finish("stop");
    pending.push(cancel);
    if (selectedRun !== run) selectRun(run);
    S.el.classList.remove("collapsed");
    append(S.body, node);
    this.status(`Waiting for you to complete the ${kind}…`);
    return { done, resolve: finish };
  },

  /** A required detail the vault doesn't have: ask, optionally save it. Resolves { value, save } or null. */
  askVault(S, question, key) {
    const run = activeRun;
    setRunStatus(run, "waiting");
    return new Promise((resolve) => {
      const input = h("input", { class: "input", type: /PASS|PIN|OTP|CVV/.test(key) ? "password" : "text", placeholder: key.replace(/_/g, " ").toLowerCase(), spellcheck: "false" });
      const saveBox = h("input", { type: "checkbox", checked: true });
      const box = card(
        { title: "A detail is needed", badge: "local", badgeText: "you" },
        h("div", { class: "ask-box" }, h("div", {}, question), input, h("label", { class: "ask-save" }, saveBox, h("span", {}, `Save to my private vault as ${key}`))),
        h("div", { class: "note" }, `Stays on this device — the AI only ever sees [VAULT_${key}].`),
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn primary", onclick: () => input.value.trim() && done({ value: input.value.trim(), save: saveBox.checked }) }, "Use this"),
          h("button", { class: "btn danger", onclick: () => done(null) }, "Stop")
        )
      );
      box.classList.add("zone-local");
      const done = (v) => {
        box.querySelector(".row")?.remove();
        input.disabled = true;
        input.value = v ? "•".repeat(Math.min(12, v.value.length)) : input.value;
        saveBox.disabled = true;
        pending = pending.filter((p) => p !== cancel);
        if (run.status === "waiting") setRunStatus(run, "running");
        if (v) S.action = `you supplied [VAULT_${key}]${v.save ? " (saved to vault)" : ""}`;
        resolve(v);
      };
      input.addEventListener("keydown", (e) => e.key === "Enter" && input.value.trim() && done({ value: input.value.trim(), save: saveBox.checked }));
      const cancel = () => done(null);
      pending.push(cancel);
      if (selectedRun !== run) selectRun(run);
      S.el.classList.remove("collapsed");
      append(S.body, box);
      input.focus();
      this.status(`Waiting for your ${key.toLowerCase().replace(/_/g, " ")}…`);
    });
  },

  cancelPending() {
    for (const p of [...pending]) p();
    pending = [];
    for (const d of [...dwellers]) d();
  },

  finish({ ok, message }) {
    const run = activeRun;
    if (!run) {
      this.status(message);
      return;
    }
    removePlaceholders(run);
    run.stage = null;
    const last = run.steps[run.steps.length - 1];
    if (last && !ok && !last.result) last.result = { kind: "bad", text: message };
    if (last) summarizeStep(run, last, { collapse: false });
    run.el.append(h("div", { class: `final${ok ? "" : " bad"}` }, h("span", { class: "lbl" }, ok ? "Result" : "Stopped"), message));
    run.log.result = { ok, message, finishedAt: new Date().toISOString() };
    activeRun = null;
    setRunStatus(run, ok ? "done" : "stopped");
    updateRunStats(run);
    followBtn.hidden = true;
    if (run === selectedRun && follow.on) glideTo(run.el.lastChild, 900);
    this.status("");
    setRunning(false);
  },
};

const agent = new StellarAgent(ui);

function setRunning(on) {
  runBtn.disabled = on;
  snapBtn.disabled = on;
  stopBtn.hidden = !on;
}

// ------------------------------------------------------------------ events

function start(mode) {
  if (agent.running) return;
  const task = taskInput.value.trim();
  if (mode === "agent" && !task) {
    ui.status("Type a task first — or use Snapshot to just see redaction.");
    taskInput.focus();
    return;
  }
  agent.run({ task, mode }).catch((e) => ui.finish({ ok: false, message: e.message || String(e) }));
}

runBtn.addEventListener("click", () => start("agent"));
snapBtn.addEventListener("click", () => start("snapshot"));
stopBtn.addEventListener("click", () => agent.stop());
taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) start("agent");
});

$("#clearBtn").addEventListener("click", () => {
  for (const r of [...runs]) if (r !== activeRun) closeRun(r);
});

$("#exportBtn").addEventListener("click", () => {
  if (!selectedRun) return ui.status("Nothing to export yet.");
  const blob = new Blob([JSON.stringify(selectedRun.log, null, 2)], { type: "application/json" });
  const name = selectedRun.title.toLowerCase().replace(/\s+/g, "-");
  const a = h("a", { href: URL.createObjectURL(blob), download: `stellar-${name}-${Date.now()}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

// Lightbox for screenshots.
const lightbox = $("#lightbox");
feed.addEventListener("click", (e) => {
  const img = e.target.closest("img.shot");
  if (!img) return;
  const big = lightbox.querySelector("img");
  big.src = img.src;
  big.className = img.classList.contains("raw") ? "raw" : "";
  lightbox.hidden = false;
});
lightbox.addEventListener("click", () => (lightbox.hidden = true));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    lightbox.hidden = true;
    $("#settings").hidden = true;
  }
});

// Pop-out window for presenting on a bigger screen.
const popoutBtn = $("#popoutBtn");
if (new URLSearchParams(location.search).has("popout")) popoutBtn.hidden = true;
popoutBtn.addEventListener("click", () => {
  chrome.windows.create({ url: chrome.runtime.getURL("sidepanel/sidepanel.html?popout=1"), type: "popup", width: 560, height: 960 });
});

// Theme: follows the OS by default; the header button cycles system → light → dark.
const THEMES = ["system", "light", "dark"];
const themeBtn = $("#themeBtn");
function applyTheme(theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
  themeBtn.dataset.theme = theme;
  themeBtn.title = `Theme: ${theme} (click to change)`;
}
themeBtn.addEventListener("click", async () => {
  const next = THEMES[(THEMES.indexOf(themeBtn.dataset.theme || "system") + 1) % THEMES.length];
  applyTheme(next);
  await saveSettings({ theme: next });
});

// Presenter mode.
const presenterBtn = $("#presenterBtn");
function applyPresenter(on) {
  document.body.classList.toggle("presenter", on);
  presenterBtn.setAttribute("aria-pressed", String(on));
}
presenterBtn.addEventListener("click", async () => {
  const on = !document.body.classList.contains("presenter");
  applyPresenter(on);
  await saveSettings({ presenter: on });
});

// --------------------------------------------------------------- settings

const drawer = $("#settings");

async function openSettings() {
  const s = await loadSettings();
  $("#apiKey").value = s.apiKey;
  $("#reasonModel").value = s.reasonModel;
  $("#detectModel").value = s.detectModel;
  document.querySelector(`input[name=detector][value=${s.detector === "vision" ? "vision" : "local"}]`).checked = true;
  document.querySelector(`input[name=pace][value=${s.pace || "guided"}]`).checked = true;
  document.querySelector(`input[name=localBackup][value=${s.localBackup || "localfirst"}]`).checked = true;
  $("#localPreload").checked = s.localPreload !== false;
  (document.querySelector(`input[name=localUnload][value="${s.localUnloadMinutes ?? 10}"]`) || document.querySelector("input[name=localUnload][value='10']")).checked = true;
  $("#vaultGemini").checked = s.vaultExtract === "gemini";
  $("#vaultReview").replaceChildren();
  $("#maxSteps").value = s.maxSteps;
  $("#vault").value = s.vault;
  $("#saveStatus").textContent = "";
  drawer.hidden = false;
}

$("#settingsBtn").addEventListener("click", openSettings);
$("#closeSettings").addEventListener("click", () => (drawer.hidden = true));
drawer.addEventListener("click", (e) => {
  if (e.target === drawer) drawer.hidden = true;
});

$("#toggleKey").addEventListener("click", (e) => {
  const input = $("#apiKey");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  e.target.textContent = show ? "Hide" : "Show";
});

$("#testKey").addEventListener("click", async () => {
  const status = $("#keyStatus");
  const key = $("#apiKey").value.trim();
  if (!key) return (status.textContent = "Enter a key first.");
  status.textContent = "Checking…";
  try {
    const { models, working, total } = await listModels(key);
    const list = $("#modelList");
    list.replaceChildren(...models.filter((m) => /gemini|gemma/.test(m)).map((m) => h("option", { value: m })));
    const want = [$("#reasonModel").value, $("#detectModel").value];
    const missing = want.filter((m) => m && !models.includes(m));
    status.textContent =
      `✓ ${working}/${total} key${total > 1 ? "s" : ""} working — ${models.length} models available.` + (missing.length ? ` Not found: ${missing.join(", ")}` : "");
  } catch (err) {
    status.textContent = `✗ ${err.message}`;
  }
});

$("#saveSettings").addEventListener("click", async () => {
  await saveSettings({
    apiKey: $("#apiKey").value.trim(),
    reasonModel: $("#reasonModel").value.trim() || DEFAULTS.reasonModel,
    detectModel: $("#detectModel").value.trim() || DEFAULTS.detectModel,
    detector: document.querySelector("input[name=detector]:checked")?.value || "local",
    pace: document.querySelector("input[name=pace]:checked")?.value || "guided",
    localBackup: document.querySelector("input[name=localBackup]:checked")?.value || "localfirst",
    localPreload: $("#localPreload").checked,
    localUnloadMinutes: Number(document.querySelector("input[name=localUnload]:checked")?.value ?? 10),
    vaultExtract: $("#vaultGemini").checked ? "gemini" : "local",
    maxSteps: Math.max(1, Math.min(50, parseInt($("#maxSteps").value, 10) || 15)),
    vault: $("#vault").value,
  });
  configureAutoUnload(Number(document.querySelector("input[name=localUnload]:checked")?.value ?? 10));
  $("#saveStatus").textContent = "Saved ✓";
  setTimeout(() => (drawer.hidden = true), 500);
});

// ------------------------------------------------------------ on-device model

const localChip = $("#localChip");
onLocalState((st) => {
  const pct = Math.round((st.progress || 0) * 100);
  const text =
    st.status === "ready"
      ? `Ready on ${st.device === "webgpu" ? "WebGPU" : "WASM (CPU)"}${st.loadMs ? ` · loaded in ${(st.loadMs / 1000).toFixed(1)}s` : ""}`
      : st.status === "loading"
        ? `Loading… ${pct ? `${pct}%` : ""}`
        : st.status === "error"
          ? `Failed: ${st.error}`
          : st.status === "unloaded"
            ? `Unloaded${st.unloadedAfterMin ? ` after ${st.unloadedAfterMin} min idle` : ""} · memory freed`
            : "Not loaded";
  $("#localStatus").textContent = text;
  $("#localStatus").className = `local-status ${st.status}`;
  $("#localBar").style.width = `${st.status === "ready" ? 100 : pct}%`;
  $("#localLoad").disabled = st.status === "loading" || st.status === "ready";
  $("#localLoad").textContent = st.status === "ready" ? "Loaded" : st.status === "loading" ? "Loading…" : st.status === "unloaded" ? "Load again" : "Download & load";
  localChip.textContent =
    st.status === "ready"
      ? "on-device: ready"
      : st.status === "loading"
        ? `on-device: ${pct}%`
        : st.status === "error"
          ? "on-device: error"
          : st.status === "unloaded"
            ? "on-device: unloaded"
            : "on-device: off";
  localChip.dataset.state = st.status;
});
$("#localLoad").addEventListener("click", () => loadLocalModel().catch(() => {}));
localChip.addEventListener("click", openSettings);

// ------------------------------------------------------------ vault import

$("#vaultImportBtn").addEventListener("click", () => $("#vaultFile").click());
$("#vaultFile").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  const review = $("#vaultReview");
  const useGemini = $("#vaultGemini").checked;
  const s = await loadSettings();
  if (useGemini && !s.apiKey && !$("#apiKey").value.trim()) {
    review.replaceChildren(h("div", { class: "note warn" }, "Add a Gemini API key first, or untick Gemini extraction."));
    return;
  }
  const status = h("div", { class: "watch" }, h("span", { class: "spinner" }), `Reading ${files.length} file${files.length > 1 ? "s" : ""} ${useGemini ? "with Gemini" : "on this device"}…`);
  review.replaceChildren(status);
  const found = [];
  const notes = [];
  for (const f of files) {
    try {
      const r = await extractFromFile(f, { mode: useGemini ? "gemini" : "local", apiKey: $("#apiKey").value.trim() || s.apiKey, model: s.detectModel });
      found.push(...r.fields);
      notes.push(`${f.name}: ${r.fields.length} field${r.fields.length === 1 ? "" : "s"} via ${r.method}${r.note ? ` (${r.note})` : ""}`);
    } catch (err) {
      notes.push(`${f.name}: failed — ${err.message}`);
    }
  }
  renderVaultReview(found, notes);
});

function renderVaultReview(fields, notes) {
  const review = $("#vaultReview");
  const rows = fields.map((f) => {
    const keySel = h("select", {}, VAULT_FIELDS.map((k) => h("option", { value: k, ...(k === f.key ? { selected: true } : {}) }, k)));
    const val = h("input", { value: f.value, spellcheck: "false" });
    const on = h("input", { type: "checkbox", checked: true });
    return { el: h("div", { class: "vr-row" }, on, keySel, val, h("span", { class: "vr-src", title: f.source }, f.source)), on, keySel, val };
  });
  const add = h(
    "button",
    {
      class: "btn primary sm",
      type: "button",
      onclick: async () => {
        const chosen = rows.filter((r) => r.on.checked && r.val.value.trim()).map((r) => ({ key: r.keySel.value, value: r.val.value.trim() }));
        const merged = mergeIntoVault($("#vault").value, chosen);
        $("#vault").value = merged.text;
        await saveSettings({ vault: merged.text });
        review.replaceChildren(h("div", { class: "note" }, `✓ Added ${merged.added} field${merged.added === 1 ? "" : "s"} to the vault (saved). The AI will only ever see them as [VAULT_…] tags.`));
      },
    },
    `Add selected to vault`
  );
  review.replaceChildren(
    h("div", { class: "vr" }, ...notes.map((n) => h("div", { class: "note" }, n)), ...(rows.length ? rows.map((r) => r.el) : [h("div", { class: "note warn" }, "No personal details found.")]), rows.length ? h("div", { class: "row" }, add, h("button", { class: "btn ghost sm", type: "button", onclick: () => review.replaceChildren() }, "Cancel")) : null)
  );
}

// ------------------------------------------------------------- run mode switch

function applyRunMode(mode) {
  const m = mode === "autopilot" ? "autopilot" : "safe";
  document.querySelector(`input[name=runMode][value=${m}]`).checked = true;
  runBtn.title = m === "autopilot" ? "Run on Autopilot: no approval prompts" : "Run in Safe mode: asks before risky actions";
}
document.querySelectorAll("input[name=runMode]").forEach((r) =>
  r.addEventListener("change", async () => {
    applyRunMode(r.value);
    await saveSettings({ runMode: r.value });
    ui.status(r.value === "autopilot" ? "Autopilot: no approval prompts — it only stops for real questions (missing details, CAPTCHAs)." : "Safe mode: asks before risky actions, vault fills and pasting secrets.");
  })
);

// ------------------------------------------------------------------- init

(async () => {
  const s = await loadSettings();
  applyPresenter(s.presenter);
  applyTheme(s.theme || "system");
  applyRunMode(s.runMode);
  configureAutoUnload(s.localUnloadMinutes ?? 10);
  // Warm the on-device model in the background once it has been downloaded.
  if (s.localBackup !== "off" && s.localPreload !== false && (await isLocalModelCached())) loadLocalModel().catch(() => {});
  if (!s.apiKey) {
    ui.status("Add your Gemini API key in Settings (gear icon) to begin.");
  }
})();
