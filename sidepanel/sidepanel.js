// Side panel UI: renders each pipeline stage as it happens and wires settings.
// All page/model-derived strings go through textContent (never innerHTML).

import { StellarAgent, describeAction, findTargetTab } from "./agent.js";
import { loadSettings, saveSettings, DEFAULTS } from "./settings.js";
import { listModels, parseKeys } from "./gemini.js";
import { CATEGORY_COLORS } from "./privacy.js";
import { loadLocalModel, onLocalState, isLocalModelCached, localState, LOCAL_MODEL, configureAutoUnload } from "./local/vlm.js";
import { extractFromFile, mergeIntoVault, VAULT_FIELDS } from "./vault-import.js";
import { listFiles, putFile, deleteFile, renameFile, guessFileKey, prettySize, fileTag } from "./vault-files.js";
import { VOICE_LANGS, Listener, speak, stopSpeaking, voiceSupported, identifyLanguage, languageName, fullTag } from "./voice.js";
import { newReport, addHidden, categoryOfTag, reportText, reportJson } from "./report.js";
import { summarizeTab, askAboutPage } from "./summary.js";
import { SHOPS, DEFAULT_SHOPS, parseCompareQuery, comparePrices } from "./compare.js";
import { EVERY_DAY, DAY_NAMES, listSchedules, upsertSchedule, updateSchedule, removeSchedule, armSchedule, describeWhen, describeNext, parseScheduleText, openRunner, createWindowAt } from "./schedules.js";

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
        title: local ? (d.localFirst ? "Reason (on-device, confident)" : d.localOnly ? "Reason (on-device)" : "Reason (on-device backup)") : /final verification/.test(d.whyCloud || "") ? "Reason (cloud · final verification)" : "Reason",
        badge: local ? "local" : "cloud",
        badgeText: local ? "on-device" : "cloud",
        meta: `${d.latencyMs} ms`,
        cloud: !local,
      },
      d.fallback ? h("div", { class: "note warn" }, `Gemini failed (${d.fallback.slice(0, 160)}) — ${LOCAL_MODEL.name} decided this step on your device.`) : null,
      d.whyCloud ? h("div", { class: "note" }, `Why the cloud: ${d.whyCloud}.`) : null,
      d.labelled ? shot(d.labelled, true) : null,
      d.labelled ? h("div", { class: "note" }, "Labelled frame — element tags only, no redaction needed: it never left this device.") : null,
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

const KIND_TITLE = { summary: "Summary", compare: "Compare" };

// kind: "agent" | "snapshot" | "summary" | "compare". meta: { id, title, schedule } for a scheduled run.
function makeRun({ task, snapshot, settings, maxSteps, kind = snapshot ? "snapshot" : "agent", meta = null, detail = "" }) {
  const id = meta?.id ?? ++runSeq;
  const title = meta?.title || (snapshot ? `Snapshot ${id}` : KIND_TITLE[kind] ? `${KIND_TITLE[kind]} ${id}` : `Task ${id}`);
  const modeLabel = `${settings.runMode === "autopilot" ? "Autopilot" : "Safe mode"} · ${{ localfirst: "Local-first", auto: "Gemini-first", always: "On-device only", off: "Gemini only" }[settings.localBackup] || ""}`;
  const label =
    kind === "snapshot"
      ? "Snapshot"
      : kind === "summary"
        ? "Page summary · private data hidden first"
        : kind === "compare"
          ? `${meta?.schedule ? `Price watch · ${describeWhen(meta.schedule)}` : "Price compare"}${detail ? ` · ${detail}` : ""}`
          : meta?.schedule
            ? `Scheduled · ${describeWhen(meta.schedule)} · ${modeLabel}`
            : `Task ${id} · ${modeLabel}`;
  const run = {
    id,
    title,
    task,
    snapshot,
    kind,
    scheduled: !!meta?.schedule,
    rep: newReport(),
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
      mode: kind,
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
      h("div", { class: "lbl" }, label),
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
  addRunTab(run);
  watchRun(run);
  return run;
}

function addRunTab(run) {
  run.dot = h("span", { class: `sdot ${run.status}` });
  run.tab = h(
    "button",
    { class: "runtab", role: "tab", title: run.snapshot ? "Privacy snapshot" : run.task, onclick: () => selectRun(run) },
    run.dot,
    h("span", { class: "t" }, run.title),
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
}

// ------------------------------------------------------------ saved tasks
// Tasks survive closing and reopening the panel; only × (or Clear) removes
// one. They are kept in this extension's IndexedDB on this device. Unredacted
// captures are not written to disk — saved copies show a note instead.

const runStore = (() => {
  let dbp = null;
  const open = () =>
    (dbp ||= new Promise((resolve, reject) => {
      const r = indexedDB.open("stellar-runs", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("runs", { keyPath: "id" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction("runs", mode);
      const req = fn(t.objectStore("runs"));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
    });
  };
  return {
    put: (rec) => tx("readwrite", (s) => s.put(rec)).catch(() => {}),
    del: (id) => tx("readwrite", (s) => s.delete(id)).catch(() => {}),
    all: () => tx("readonly", (s) => s.getAll()).catch(() => []),
  };
})();

const saveTimers = new Map();

function savedCopy(run) {
  const clone = run.el.cloneNode(true);
  clone.classList.remove("sel");
  clone.querySelectorAll("img.shot.raw").forEach((img) => img.replaceWith(h("div", { class: "note" }, "Unredacted capture — shown live only, never saved to disk.")));
  clone.querySelectorAll(":scope > .followup").forEach((n) => n.remove());
  return {
    id: run.id,
    title: run.title,
    task: run.task,
    snapshot: run.snapshot,
    kind: run.kind,
    status: run.status,
    html: clone.innerHTML,
    log: run.log,
    // Kept so "Continue" works after the panel is reopened (step summaries only, tags not values).
    agentHistory: (run.agentHistory || []).map(({ text, sig }) => ({ text, sig })),
    finalMessage: run.finalMessage || "",
    lang: run.lang || "",
    savedAt: Date.now(),
  };
}

function persistRun(run, delay = 700) {
  clearTimeout(saveTimers.get(run));
  const save = () => {
    saveTimers.delete(run);
    if (runs.includes(run)) runStore.put(savedCopy(run));
  };
  if (delay <= 0) return save();
  saveTimers.set(run, setTimeout(save, delay));
}

function watchRun(run) {
  new MutationObserver(() => persistRun(run)).observe(run.el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  persistRun(run);
}

// Write anything pending as the panel closes.
addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  for (const run of [...saveTimers.keys()]) persistRun(run, 0);
});

/** Rebuild saved tasks; a task that was running when the panel closed is marked stopped. */
async function restoreRuns() {
  const started = (s) => Date.parse(s.log?.startedAt) || 0;
  const saved = (await runStore.all()).sort((a, b) => started(a) - started(b) || a.id - b.id);
  if (!saved.length) return;
  hideHome();
  for (const s of saved) {
    if (s.id < 1e9) runSeq = Math.max(runSeq, s.id); // scheduled runs use time-based ids
    const el = h("section", { class: "run", "data-run": s.id });
    el.innerHTML = s.html;
    // Approvals, questions and hand-offs from the old session can't be answered any more.
    el.querySelectorAll(".card .row:has(.btn.ok, .btn.primary, .btn.danger), .watch").forEach((n) => n.remove());
    el.querySelectorAll(".card input, .card textarea").forEach((n) => (n.disabled = true));
    let status = s.status;
    if (status === "running" || status === "waiting") {
      status = "stopped";
      el.querySelectorAll(".spinner").forEach((n) => n.remove());
      el.querySelectorAll(".step.live").forEach((n) => {
        n.classList.remove("live");
        const sum = n.querySelector(".sum");
        if (sum) sum.textContent = "✗ interrupted";
      });
      el.querySelectorAll(".card.pending").forEach((n) => n.remove());
      el.append(h("div", { class: "final bad" }, h("span", { class: "lbl" }, "Stopped"), "The side panel was closed while this task was running. Run it again to continue."));
    }
    const run = {
      id: s.id, title: s.title, task: s.task, snapshot: s.snapshot, kind: s.kind || (s.snapshot ? "snapshot" : "agent"), status, restored: true, steps: [], el,
      log: s.log || {}, statsEl: el.querySelector(".run-stats"), stats: { tags: new Set(), bytes: 0, leaks: 0 },
      agentHistory: s.agentHistory || [], finalMessage: s.finalMessage || (status === "stopped" ? "The side panel was closed while this task was running." : ""), lang: s.lang || "",
    };
    // Restored cards are plain HTML, so their clicks are handled here.
    el.addEventListener("click", (e) => {
      const seg = e.target.closest(".seg");
      if (seg) {
        e.stopPropagation();
        const step = seg.closest(".step");
        step.classList.remove("collapsed");
        const stage = STAGES[[...seg.parentElement.children].indexOf(seg)];
        const target = step.querySelector(`.card[data-stage="${stage}"]`) || step;
        setTimeout(() => glideTo(target, 700), 50);
        return;
      }
      const head = e.target.closest(".step-h");
      if (head) return head.closest(".step").classList.toggle("collapsed");
      const tool = e.target.closest(".run-tools .link");
      if (tool) for (const st of el.querySelectorAll(".step")) st.classList.toggle("collapsed", /Collapse/.test(tool.textContent));
    });
    feed.append(el);
    addRunTab(run);
    if (run.kind === "agent") addFollowUp(run);
    watchRun(run);
  }
  let pick = null;
  try {
    pick = runs.find((r) => String(r.id) === localStorage.getItem("stellar.selectedRun"));
  } catch {
    /* storage unavailable */
  }
  selectRun(pick || runs[runs.length - 1]);
}

function selectRun(run) {
  selectedRun = run;
  try {
    if (run) localStorage.setItem("stellar.selectedRun", String(run.id));
  } catch {
    /* storage unavailable */
  }
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
  clearTimeout(saveTimers.get(run));
  saveTimers.delete(run);
  runStore.del(run.id);
  run.el.remove();
  run.tab.remove();
  runs.splice(runs.indexOf(run), 1);
  if (selectedRun === run) selectRun(runs[runs.length - 1] || null);
  if (!runs.length) {
    runbar.hidden = true;
    showHome();
  }
}

function setRunStatus(run, status) {
  if (run.scheduled && status === "waiting" && run.status !== "waiting") callUser(run);
  run.status = status;
  run.dot.className = `sdot ${status}`;
  updateRunStats(run);
  persistRun(run);
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
  if (run.restored) return; // a saved copy keeps the stats line it was saved with
  const n = run.steps.length;
  const secs = ((performance.now() - run.t0) / 1000).toFixed(1);
  if (run.kind === "summary" || run.kind === "compare") {
    const hidden = Object.values(run.rep.hidden).reduce((t, set) => t + set.size, 0);
    run.statsEl.textContent = [
      run.kind === "summary" ? "page summary" : "price compare",
      `${hidden} private item${hidden === 1 ? "" : "s"} hidden`,
      run.rep.chars ? `${run.rep.chars.toLocaleString()} chars of tagged text sent` : "nothing sent",
      `${run.rep.leaksBlocked} leak${run.rep.leaksBlocked === 1 ? "" : "s"}`,
      `${secs}s`,
    ].join(" · ");
    return;
  }
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
  runStarted({ task, snapshot, settings, maxSteps, lang, spoken, history, continueRun, tagMemory }) {
    hideHome();
    let stepBase = 0;
    if (continueRun && runs.includes(continueRun)) {
      // A follow-up continues in the same task card, below the last result.
      activeRun = continueRun;
      stepBase = Math.max(activeRun.steps.length, activeRun.el.querySelectorAll(".step").length);
      activeRun.el.querySelector(":scope > .followup")?.remove();
      activeRun.log.steps ||= [];
      activeRun.el.append(h("div", { class: "followup-h" }, h("span", { class: "lbl" }, "Follow-up"), task));
      activeRun.rep = newReport();
      setRunStatus(activeRun, "running");
    } else {
      const meta = pendingRunMeta;
      pendingRunMeta = null;
      activeRun = makeRun({ task, snapshot, settings, maxSteps, meta });
    }
    activeRun.agentHistory = history;
    activeRun.tagMemory = tagMemory;
    activeRun.lang = lang;
    activeRun.spoken = spoken && settings.speakReplies !== false;
    selectRun(activeRun);
    setFollow(true);
    setRunning(true);
    this.status(snapshot ? "Taking a privacy snapshot…" : "Starting…");
    return { stepBase };
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

  /** Stages not needed this step (the on-device model decided): no redaction, nothing sent. */
  skipStages(S, stages) {
    for (const st of stages) S.stages.set(st, "skipped");
    removePlaceholders(activeRun);
    setBrief(S, "hidden", "local", "Hidden", h("span", { class: "dim" }, "redaction not needed — the frame never left this device"));
    setBrief(S, "sent", "local", "Sent", h("span", { class: "dim" }, "nothing — decided on-device"));
    renderStageBar(activeRun, S);
  },

  /** Fill the step's short brief from a stage's data. */
  brief(run, S, stage, data) {
    const rep = run.rep;
    if (rep) rep.touched = true;
    if (stage === "detect") {
      const uniq = uniqueRegions(data.regions);
      uniq.forEach((r) => run.stats.tags.add(r.tag));
      if (rep) {
        uniq.forEach((r) => addHidden(rep, r.tag));
        if (data.mode === "vision" && data.visionMeta) rep.rawFramesSent++;
      }
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
        if (rep && S.leakOk) {
          rep.cloudRequests++;
          rep.leakChecks++;
          rep.bytes += data.bytes;
          rep.chars += data.prompt.length;
        } else if (rep) rep.leaksBlocked++;
        run.stats.bytes += data.bytes;
        run.stats.leaks += data.leaks.length;
        setBrief(S, "sent", "cloud", "Sent", S.sendInfo, h("span", { class: `pill ${S.leakOk ? "ok" : "bad"}` }, S.leakOk ? "✓ 0 leaks" : "✗ blocked"));
      }
    }
    if (stage === "reason" && data.local) {
      if (rep) rep.localSteps++;
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
    if (run.spoken) speak(question, run.lang);
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

  handoff(S, kind, copy = null) {
    const run = activeRun;
    setRunStatus(run, "waiting");
    S.action = copy ? `${copy.title.toLowerCase()} — ${kind}` : `human verification — ${kind}`;
    setBrief(S, "sent", "local", "Sent", h("span", { class: "dim" }, copy ? `nothing — paused: ${copy.title.toLowerCase()}` : `nothing — paused for you to complete the ${kind}`));
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const live = h("div", { class: "watch" }, h("span", { class: "spinner" }), copy?.watching || "Watching the tab — resumes automatically once the check is cleared…");
    const buttons = h(
      "div",
      { class: "row" },
      h("button", { class: "btn ok", onclick: () => finish("manual") }, "Continue"),
      h("button", { class: "btn danger", onclick: () => finish("stop") }, "Stop")
    );
    const node = card(
      { title: copy?.title || "Human verification needed", badge: "mixed", badgeText: "you" },
      copy ? h("div", {}, copy.body) : h("div", {}, h("b", {}, kind), " is on the page. Stellar doesn't solve CAPTCHAs or bot checks — please complete it yourself in the tab."),
      h("div", { class: "note" }, copy?.note || "No check on the page? Click Continue — Stellar won't ask about it again during this task."),
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
      const msg = { auto: copy ? "✓ Done — resuming" : "✓ Check cleared — resuming", manual: "✓ You marked it done — resuming", stop: "✗ Stopped", timeout: "✗ Timed out" }[v];
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
    this.status(copy?.waiting || `Waiting for you to complete the ${kind}…`);
    return { done, resolve: finish };
  },

  /** A required detail the vault doesn't have: ask, optionally save it. Resolves { value, save } or null. */
  askVault(S, question, key) {
    const run = activeRun;
    setRunStatus(run, "waiting");
    if (run.spoken) speak(question, run.lang);
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

  finish({ ok, message, contextMessage }) {
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
    run.el.append(h("div", { class: `final${ok ? "" : " bad"}` }, h("span", { class: "lbl" }, ok ? "Result" : "Stopped"), h("span", { class: "msg" }, message), resultActions(run, ok)));
    run.log.result = { ok, message, finishedAt: new Date().toISOString() };
    if (run.rep?.touched) {
      run.el.append(renderReport(run.rep));
      run.log.privacyReport = reportJson(run.rep);
    }
    // What a follow-up sends as context: the tagged answer, not the names shown here.
    run.finalMessage = contextMessage || message;
    run.displayMessage = message;
    this.lastFinished = run;
    if (run.kind === "agent") addFollowUp(run);
    if (run.spoken) speak(message, run.lang);
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

// A summary or price compare in progress (they don't use the agent loop).
let toolAbort = null;
const busy = () => agent.running || !!toolAbort;

function setRunning(on) {
  runBtn.disabled = on;
  snapBtn.disabled = on;
  for (const b of document.querySelectorAll(".tools-row .tool")) if (b.id !== "schedBtn") b.disabled = on;
  stopBtn.hidden = !on;
}

// ------------------------------------------------------------------ events

function start(mode) {
  if (busy()) return;
  const task = taskInput.value.trim();
  if (mode === "agent" && !task) {
    ui.status("Type a task first — or use Snapshot to just see redaction.");
    taskInput.focus();
    return;
  }
  const spokenNow = voiceState.text && voiceState.text === task;
  startRun({ task, mode, spoken: !!spokenNow, lang: spokenNow ? voiceState.lang : null });
}

/** Start a run — or, with continueRun, a follow-up in that task's conversation. */
function startRun({ task, mode = "agent", spoken = false, lang = null, continueRun = null, runMode = null, startTabId = null }) {
  if (busy()) return Promise.resolve(ui.status("Wait for the current task to finish (or press Stop)."));
  if (mode === "agent" && !continueRun && !startTabId) rememberTask(task);
  // Answer in the language of the task: the spoken language, or (typed) identified on-device.
  const langP = lang != null ? Promise.resolve(lang) : mode === "agent" ? identifyLanguage(task).then((b) => (b ? fullTag(b) : "")) : Promise.resolve("");
  return langP.then((l) => agent.run({ task, mode, lang: l, spoken, continueRun, runMode, startTabId }).catch((e) => ui.finish({ ok: false, message: e.message || String(e) })));
}

/** "Continue this task" box under a finished task. */
function addFollowUp(run) {
  run.el.querySelector(":scope > .followup")?.remove();
  const input = h("textarea", { class: "input", rows: 1, placeholder: "Continue this task — e.g. “now upload my résumé too” or “use the other account”…" });
  const form = h(
    "form",
    {
      class: "followup",
      onsubmit: (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return input.focus();
        startRun({ task: text, continueRun: run });
      },
    },
    input,
    h("button", { class: "btn primary sm", type: "submit" }, "Continue")
  );
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  run.el.append(form);
}

// ------------------------------------------------------------------ voice

const micBtn = $("#micBtn");
const voiceLang = $("#voiceLang");
const voiceState = { listener: null, text: "", lang: "", timer: null };
voiceLang.append(...VOICE_LANGS.map(([v, label]) => h("option", { value: v }, label)));

function cancelAutoRun() {
  clearTimeout(voiceState.timer);
  voiceState.timer = null;
}

function setListening(on) {
  micBtn.setAttribute("aria-pressed", on ? "true" : "false");
  micBtn.title = on ? "Stop listening" : "Speak your task (any language)";
}

micBtn.addEventListener("click", async () => {
  stopSpeaking();
  cancelAutoRun();
  if (voiceState.listener) {
    voiceState.listener.stop();
    return;
  }
  if (!voiceSupported()) return ui.status("This browser has no speech recognition.");
  const s = await loadSettings();
  const listener = new Listener({
    lang: voiceLang.value,
    settings: s,
    lastLang: s.lastVoiceLang,
    onStatus: (t) => ui.status(t),
    onInterim: (t) => (taskInput.value = t),
    onDone: async ({ text, lang, via, note }) => {
      voiceState.listener = null;
      setListening(false);
      taskInput.value = text;
      voiceState.text = text;
      voiceState.lang = lang;
      await saveSettings({ lastVoiceLang: lang });
      if (agent.running) return ui.status(`Heard (${languageName(lang)}).`);
      // Hands-free: run shortly unless the user starts editing.
      const how = via === "gemini" ? " (language identified by Gemini)" : note ? ` (browser only — ${note}; pick your language in the menu if this is wrong)` : "";
      ui.status(`Heard in ${languageName(lang)}${how} — running in 2 s… click the box to edit instead.`);
      voiceState.timer = setTimeout(() => {
        voiceState.timer = null;
        start("agent");
      }, 2000);
    },
    onError: (code, message) => {
      voiceState.listener = null;
      setListening(false);
      if (code === "not-allowed") {
        chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel/mic.html") });
        return ui.status("Allow the microphone in the tab that just opened, then press 🎤 again.");
      }
      ui.status(message);
    },
  });
  voiceState.listener = listener;
  setListening(true);
  listener.start();
});

voiceLang.addEventListener("change", () => saveSettings({ voiceLang: voiceLang.value }));
taskInput.addEventListener("focus", cancelAutoRun);
taskInput.addEventListener("input", () => {
  cancelAutoRun();
  if (taskInput.value !== voiceState.text) voiceState.text = "";
});

runBtn.addEventListener("click", () => start("agent"));
snapBtn.addEventListener("click", () => start("snapshot"));
stopBtn.addEventListener("click", () => {
  agent.stop();
  toolAbort?.abort();
});
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
    $("#schedules").hidden = true;
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
  $("#realClick").checked = s.realClick !== false;
  $("#redactNames").checked = s.redactNames !== false;
  $("#speakReplies").checked = s.speakReplies !== false;
  (document.querySelector(`input[name=localUnload][value="${s.localUnloadMinutes ?? 10}"]`) || document.querySelector("input[name=localUnload][value='10']")).checked = true;
  $("#vaultGemini").checked = s.vaultExtract === "gemini";
  $("#vaultReview").replaceChildren();
  (document.querySelector(`input[name=vaultFileMode][value=${s.vaultFileMode || "both"}]`) || document.querySelector("input[name=vaultFileMode][value=both]")).checked = true;
  renderVaultFiles();
  $("#maxSteps").value = s.maxSteps;
  const shops = s.compareShops?.length ? s.compareShops : DEFAULT_SHOPS;
  document.querySelectorAll("#compareShops input").forEach((c) => (c.checked = shops.includes(c.value)));
  $("#compareKeepTabs").checked = !!s.compareKeepTabs;
  $("#vault").value = s.vault;
  $("#saveStatus").textContent = "Changes save automatically.";
  drawer.hidden = false;
  drawer.querySelector(".drawer-inner").dispatchEvent(new Event("scroll"));
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

/** Everything in the drawer, saved as one patch. */
async function saveAllSettings() {
  await saveSettings({
    apiKey: $("#apiKey").value.trim(),
    reasonModel: $("#reasonModel").value.trim() || DEFAULTS.reasonModel,
    detectModel: $("#detectModel").value.trim() || DEFAULTS.detectModel,
    detector: document.querySelector("input[name=detector]:checked")?.value || "local",
    pace: document.querySelector("input[name=pace]:checked")?.value || "guided",
    localBackup: document.querySelector("input[name=localBackup]:checked")?.value || "localfirst",
    localPreload: $("#localPreload").checked,
    realClick: $("#realClick").checked,
    redactNames: $("#redactNames").checked,
    speakReplies: $("#speakReplies").checked,
    localUnloadMinutes: Number(document.querySelector("input[name=localUnload]:checked")?.value ?? 10),
    vaultExtract: $("#vaultGemini").checked ? "gemini" : "local",
    maxSteps: Math.max(1, Math.min(50, parseInt($("#maxSteps").value, 10) || 15)),
    compareShops: [...document.querySelectorAll("#compareShops input:checked")].map((c) => c.value),
    compareKeepTabs: $("#compareKeepTabs").checked,
    vault: $("#vault").value,
  });
  configureAutoUnload(Number(document.querySelector("input[name=localUnload]:checked")?.value ?? 10));
  refreshSetup();
}

// Settings save as you change them; "Done" just closes the drawer.
let autosaveTimer = 0;
function autosave(delay) {
  clearTimeout(autosaveTimer);
  $("#saveStatus").textContent = "Saving…";
  autosaveTimer = setTimeout(async () => {
    await saveAllSettings();
    $("#saveStatus").textContent = "Saved ✓";
  }, delay);
}
drawer.addEventListener("change", (e) => {
  if (e.target.closest("#vaultReview, #vaultFiles, #vaultFile")) return;
  autosave(150);
});
drawer.addEventListener("input", (e) => {
  if (e.target.matches("input[type=text], input[type=password], input[type=number], input:not([type]), textarea") && !e.target.closest("#vaultReview, #vaultFiles")) autosave(700);
});
$("#saveSettings").addEventListener("click", async () => {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    await saveAllSettings();
  }
  drawer.hidden = true;
});

// Section tabs: jump to a section; the one in view is highlighted.
const setNav = $("#setNav");
setNav.addEventListener("click", (e) => {
  const a = e.target.closest("a[href^='#']");
  if (!a) return;
  e.preventDefault();
  const target = drawer.querySelector(a.getAttribute("href"));
  const inner = drawer.querySelector(".drawer-inner");
  const offset = drawer.querySelector(".drawer-h").offsetHeight + setNav.offsetHeight + 8;
  inner.scrollTo({ top: target.offsetTop - offset, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});
drawer.querySelector(".drawer-inner").addEventListener(
  "scroll",
  () => {
    const inner = drawer.querySelector(".drawer-inner");
    const line = inner.scrollTop + drawer.querySelector(".drawer-h").offsetHeight + setNav.offsetHeight + 40;
    let current = null;
    for (const a of setNav.querySelectorAll("a")) {
      const sec = drawer.querySelector(a.getAttribute("href"));
      if (sec && sec.offsetTop <= line) current = a;
    }
    if (inner.scrollTop + inner.clientHeight >= inner.scrollHeight - 4) current = setNav.querySelector("a:last-child");
    setNav.querySelectorAll("a").forEach((a) => a.classList.toggle("on", a === (current || setNav.firstElementChild)));
  },
  { passive: true }
);

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
document.querySelectorAll("input[name=vaultFileMode]").forEach((r) => r.addEventListener("change", () => saveSettings({ vaultFileMode: r.value })));

const EXTRACTABLE = /^image\/|pdf$|\.(pdf|docx|txt|csv|json|vcf)$/i;

$("#vaultFile").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  const review = $("#vaultReview");
  const mode = document.querySelector("input[name=vaultFileMode]:checked")?.value || "both";
  const store = mode !== "extract";
  const extract = mode !== "store";
  const useGemini = $("#vaultGemini").checked;
  const s = await loadSettings();
  const notes = [];
  if (store) {
    const taken = (await listFiles()).map((f) => f.key);
    for (const f of files) {
      const key = guessFileKey(f, taken);
      taken.push(key);
      try {
        await putFile(key, f);
        notes.push(`${f.name}: stored on this device as ${fileTag(key)} for upload fields.`);
      } catch (err) {
        notes.push(`${f.name}: couldn't store — ${err.message}`);
      }
    }
    renderVaultFiles();
  }
  if (!extract) return review.replaceChildren(h("div", { class: "vr" }, ...notes.map((n) => h("div", { class: "note" }, n))));
  if (useGemini && !s.apiKey && !$("#apiKey").value.trim()) {
    review.replaceChildren(h("div", { class: "note warn" }, "Add a Gemini API key first, or untick Gemini extraction."));
    return;
  }
  const readable = files.filter((f) => EXTRACTABLE.test(f.type) || EXTRACTABLE.test(f.name));
  for (const f of files) if (!readable.includes(f)) notes.push(`${f.name}: no details to read from this file type.`);
  if (!readable.length) return renderVaultReview([], notes);
  const status = h("div", { class: "watch" }, h("span", { class: "spinner" }), `Reading ${readable.length} file${readable.length > 1 ? "s" : ""} ${useGemini ? "with Gemini" : "on this device"}…`);
  review.replaceChildren(status);
  const found = [];
  for (const f of readable) {
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

/** Stored files list: rename the tag, or remove the file. */
async function renderVaultFiles() {
  const box = $("#vaultFiles");
  const files = await listFiles();
  if (!files.length) {
    box.replaceChildren(h("p", { class: "set-hint" }, "None yet. Add your résumé with “Store the file” or “Both” — Stellar attaches it when a site asks for an upload."));
    return;
  }
  box.replaceChildren(
    ...files.map((f) => {
      const icon = /pdf/.test(f.type) ? "📄" : /^image\//.test(f.type) ? "🖼️" : /word|docx/.test(f.type + f.name) ? "📝" : "📎";
      const key = h("input", { class: "vf-key", value: f.key, title: "The AI sees this file as [FILE_<this>]", spellcheck: "false" });
      key.addEventListener("change", async () => {
        const next = key.value.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_|_$/g, "") || f.key;
        if (next !== f.key && !(await listFiles()).some((o) => o.key === next)) await renameFile(f.key, next);
        renderVaultFiles();
      });
      return h(
        "div",
        { class: "vf-row" },
        h("span", { class: "vf-icon" }, icon),
        h("div", { class: "vf-name", title: f.name }, f.name, h("small", {}, `${prettySize(f.size)} · AI sees ${fileTag(f.key)}`)),
        key,
        h("button", { class: "vf-del", type: "button", title: "Remove from this device", onclick: async () => { await deleteFile(f.key); renderVaultFiles(); } }, "×")
      );
    })
  );
}

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

// ---------------------------------------------------------- privacy report
// Shown under every finished task: what was hidden here, what went out.

function renderReport(rep) {
  const t = reportText(rep);
  return h(
    "section",
    { class: "report" },
    h("div", { class: "report-h" }, h("span", { class: "shield" }, "🛡"), "Privacy report"),
    h("p", { class: "report-line" }, h("b", {}, t.hid), " ", h("span", { class: t.sentOk ? "sent-ok" : "sent-bad" }, t.sent)),
    t.counts.length
      ? h(
          "div",
          { class: "report-grid" },
          t.counts.map((c) => {
            const color = CATEGORY_COLORS[c.category] || "#94a3b8";
            return h("div", { class: "report-tile", style: { borderColor: color + "55", background: color + "12" } }, h("b", { style: { color } }, c.count), h("span", {}, c.label));
          })
        )
      : null,
    t.facts.length ? h("ul", { class: "report-facts" }, t.facts.map((f) => h("li", { class: f.ok ? "ok" : "bad" }, h("span", { class: "i" }, f.ok ? "✓" : "!"), h("span", {}, f.text)))) : null
  );
}

// ------------------------------------------------- summary & price compare
// One-click tools. They run outside the step-by-step agent loop but use the
// same task tabs, privacy layer, leak check and privacy report.

const RESTRICTED_PAGE = /^(chrome|edge|brave|about|chrome-extension|devtools|view-source|chrome-search):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;

function beginToolRun(kind, task, settings, detail = "", meta = null) {
  hideHome();
  const run = makeRun({ task, settings, kind, maxSteps: 0, detail, meta });
  activeRun = run;
  selectRun(run);
  setFollow(true);
  toolAbort = new AbortController();
  setRunning(true);
  return { run, signal: toolAbort.signal };
}

function endToolRun(result) {
  toolAbort = null;
  ui.finish(result);
}

function toolCard(run, node, zone) {
  node.classList.add(`zone-${zone}`);
  append(run.el, node);
  return node;
}

function clipText(s, n) {
  return s.length > n ? `${s.slice(0, n)}\n… (${(s.length - n).toLocaleString()} more characters)` : s;
}

/** Leak check + exactly what goes to Gemini (tagged text only, no screenshot). */
function textSendCard(d, title) {
  const leak = d.leaks.length
    ? h("div", { class: "leak bad" }, `✗ Leak check failed: ${d.leaks.map((t) => `[${t}]`).join(", ")} in the outbound text — nothing sent`)
    : h("div", { class: "leak ok" }, `✓ Leak check passed — 0 of ${d.secretCount} locally-known private values in the outbound text`);
  return card(
    { title, badge: d.leaks.length ? "local" : "cloud", badgeText: d.leaks.length ? "blocked" : "→ cloud", meta: `${d.chars.toLocaleString()} chars`, cloud: !d.leaks.length },
    leak,
    h("div", { class: "note" }, "Text only — no screenshot, no links."),
    h("details", {}, h("summary", {}, "Exactly what is sent"), h("pre", {}, clipText(d.prompt, 20000)))
  );
}

async function runSummary() {
  if (busy()) return ui.status("Wait for the current task to finish (or press Stop).");
  const settings = await loadSettings();
  if (!settings.apiKey) return ui.status("Summaries use Gemini — add your API key in Settings (gear icon) first.");
  if (settings.localBackup === "always") return ui.status("On-device only mode is on (Settings → On-device model), so nothing may go to the cloud — summaries need Gemini.");
  const tab = await findTargetTab();
  if (!tab?.url || RESTRICTED_PAGE.test(tab.url) || /^(chrome-search|about):/.test(tab.url)) return ui.status("Open a web page first — Chrome doesn't let extensions read this one.");
  const { run, signal } = beginToolRun("summary", `Summarize ${hostOf(tab.url)}`, settings);
  ui.status("Reading the page on this device…");
  try {
    const out = await summarizeTab({
      tab,
      settings,
      signal,
      rep: run.rep,
      stages: {
        read(d) {
          run.rep.touched = true;
          toolCard(
            run,
            card(
              { title: "Read the page & hide private data", badge: "local", badgeText: "on-device", meta: `${d.ms} ms` },
              h("dl", { class: "kv" }, h("dt", {}, "Page"), h("dd", { title: d.url }, hostOf(d.url)), h("dt", {}, "Text"), h("dd", {}, `${d.chars.toLocaleString()} characters${d.truncated ? " (the first part of a long page)" : ""}`)),
              d.tags.length ? h("div", { class: "tags" }, d.tags.map((t) => tagChip(t, categoryOfTag(t)))) : h("div", { class: "note" }, "No private details found in the text."),
              h("div", { class: "note" }, "Private values were swapped for tags here, before anything left this computer.")
            ),
            "local"
          );
          ui.status("Leak-checking and sending the tagged text to Gemini…");
        },
        send(d) {
          toolCard(run, textSendCard(d, "Send tagged page text"), d.leaks.length ? "local" : "cloud");
        },
      },
    });
    const d = out.display;
    toolCard(
      run,
      card(
        { title: "Summary", badge: "cloud", badgeText: "cloud", meta: `${out.latencyMs} ms`, cloud: true },
        h("div", { class: "sum-head" }, d.headline),
        h("p", { class: "sum-text" }, d.summary),
        d.key_points.length ? h("div", { class: "sum-sec" }, h("b", {}, "Key points"), h("ul", {}, d.key_points.map((p) => h("li", {}, p)))) : null,
        d.watch_out.length ? h("div", { class: "sum-sec warn" }, h("b", {}, "⚠ Watch out for"), h("ul", {}, d.watch_out.map((p) => h("li", {}, p)))) : null,
        h("div", { class: "note" }, `${out.model} · ${usageText(out.usage)} · names filled back in on this device; passwords, cards and ID numbers stay hidden`)
      ),
      "cloud"
    );
    run.log.summary = out.summary; // tagged version only
    run.pageContext = out.context; // memory only — lets the user ask about the page
    endToolRun({ ok: true, message: d.headline || "Summary ready.", contextMessage: out.summary.headline });
    addAskBox(run);
  } catch (e) {
    endToolRun({ ok: false, message: signal.aborted ? "Stopped." : e.message || String(e) });
  }
}

const SHOP_STATE = { loading: "loading…", done: "", blocked: "needs you", failed: "failed" };

/** args: { query, shops, budget } to repeat a comparison; otherwise read from the task box. */
async function runCompare(args = null, meta = null) {
  if (busy()) return ui.status("Wait for the current task to finish (or press Stop).");
  const settings = await loadSettings();
  const picked = settings.compareShops?.length ? settings.compareShops : DEFAULT_SHOPS;
  const { query, shops, budget } = args?.query ? { budget: null, ...args, shops: args.shops?.length ? args.shops : picked } : parseCompareQuery(taskInput.value, picked);
  if (!query) {
    ui.status("Type the product first — e.g. “boAt Airdopes 141 under 2000” — then press Compare prices.");
    taskInput.focus();
    return;
  }
  const target = await findTargetTab();
  const names = shops.map((id) => SHOPS.find((s) => s.id === id)?.name).filter(Boolean);
  const { run, signal } = beginToolRun("compare", `${query}${budget != null ? ` · under ₹${budget.toLocaleString("en-IN")}` : ""}`, settings, names.join(", "), meta);
  run.compareArgs = { query, shops, budget };
  run.rep.touched = true;
  const rows = new Map();
  const list = h(
    "ul",
    { class: "shops" },
    shops.map((id) => {
      const st = h("span", { class: "st" }, "opening…");
      const li = h("li", { class: "shop loading" }, h("span", { class: "dot" }), h("b", {}, SHOPS.find((s) => s.id === id).name), st);
      rows.set(id, { li, st });
      return li;
    })
  );
  toolCard(
    run,
    card(
      { title: "Open the stores side by side", badge: "local", badgeText: "on-device" },
      list,
      h("div", { class: "note" }, "Each store opens in a background tab at the same time. Only the product cards are read — not your account, delivery address or cart.")
    ),
    "local"
  );
  ui.status(`Opening ${names.length} store${names.length === 1 ? "" : "s"} at once…`);
  try {
    const out = await comparePrices({
      query,
      shopIds: shops,
      budget,
      settings,
      signal,
      rep: run.rep,
      windowId: target?.windowId,
      onShop(id, st) {
        const r = rows.get(id);
        if (!r) return;
        r.li.className = `shop ${st.state}`;
        r.st.textContent = st.state === "done" ? `${st.count} product${st.count === 1 ? "" : "s"} read` : [SHOP_STATE[st.state], st.detail].filter(Boolean).join(" — ");
        if ([...rows.values()].every((x) => !x.li.classList.contains("loading"))) ui.status(settings.apiKey && settings.localBackup !== "always" ? "Asking Gemini which listings match…" : "Building the table…");
      },
      onSend(d) {
        toolCard(run, textSendCard(d, "Send numbered listings"), d.leaks.length ? "local" : "cloud");
      },
    });
    run.rep.notes.push("Only product cards were read from the store pages — your account name, delivery address and cart stayed on this device.");
    if (out.usedAi) run.rep.notes.push("Product links stayed on this device; Gemini saw numbered listings only.");
    toolCard(run, priceTable(out), out.usedAi ? "cloud" : "local");
    run.log.compare = { query, budget, shops, rows: out.rows.map(({ shopName, name, price, rating }) => ({ store: shopName, name, price, rating })), verdict: out.verdict };
    endToolRun({ ok: true, message: out.verdict });
  } catch (e) {
    endToolRun({ ok: false, message: signal.aborted ? "Stopped." : e.message || String(e) });
  }
}

function priceTable(out) {
  const money = (r) => r.priceText || `₹${r.price.toLocaleString("en-IN")}`;
  return card(
    { title: "Price comparison", badge: out.usedAi ? "cloud" : "local", badgeText: out.usedAi ? "Gemini-picked" : "on-device", meta: `${out.rows.length} of ${out.total} listings`, cloud: out.usedAi },
    out.aiError ? h("div", { class: "note warn" }, `${out.aiError}.`) : null,
    out.rows.length
      ? h(
          "table",
          { class: "prices" },
          h("thead", {}, h("tr", {}, h("th", {}, "Store"), h("th", {}, "Product"), h("th", { class: "num" }, "Price"), h("th", { class: "num" }, "★"))),
          h(
            "tbody",
            {},
            out.rows.map((r) =>
              h(
                "tr",
                { class: r.best ? "best" : "" },
                h("td", { class: "store" }, r.shopName),
                h(
                  "td",
                  { class: "prod" },
                  /^https?:\/\//.test(r.href) ? h("a", { href: r.href, target: "_blank", rel: "noopener noreferrer", title: r.name }, r.name) : r.name,
                  r.best ? h("span", { class: "best-pill" }, "Cheapest") : null,
                  r.sponsored ? h("span", { class: "spon" }, "sponsored") : null
                ),
                h("td", { class: "num price" }, money(r)),
                h("td", { class: "num" }, r.rating ? r.rating.toFixed(1) : "—")
              )
            )
          )
        )
      : h("div", { class: "note warn" }, "No matching listings — try a shorter product name."),
    h("div", { class: "note" }, out.usedAi ? `${out.model} picked the real matches from numbered listings (no links, no account details).` : "Matched on this device by the words in your product name.")
  );
}

$("#compareShops").append(...SHOPS.map((s) => h("label", { class: "day" }, h("input", { type: "checkbox", value: s.id }), h("span", {}, s.name))));
$("#sumBtn").addEventListener("click", () => runSummary());
$("#cmpBtn").addEventListener("click", () => runCompare());

// ---------------------------------------------------------- result actions
// Copy / Run again / Watch price under every result. Buttons are found by
// data-act, so the same handler serves tasks restored from an earlier session.

function resultActions(run, ok) {
  const b = (act, label, title) => h("button", { class: "act", type: "button", "data-act": act, title }, label);
  const acts = [b("copy", "Copy", "Copy the result")];
  if (run.kind !== "snapshot" || ok) acts.push(b("again", "↻ Run again", "Run the same task again"));
  if (run.kind === "compare" && ok) acts.push(b("watch", "⏰ Watch price daily", "Compare these prices again every day and get notified"));
  return h("div", { class: "final-actions" }, acts);
}

function runOf(el) {
  const id = el.closest(".run")?.dataset.run;
  return runs.find((r) => String(r.id) === id);
}

feed.addEventListener("click", async (e) => {
  const btn = e.target.closest(".final-actions [data-act]");
  if (!btn) return;
  const run = runOf(btn);
  if (!run) return;
  const act = btn.dataset.act;
  if (act === "copy") {
    const text = btn.closest(".final").querySelector(".msg")?.textContent || "";
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied");
    } catch {
      toast("Couldn't copy — select the text instead");
    }
    return;
  }
  if (busy()) return toast("Wait for the current task to finish");
  const cmp = run.compareArgs || run.log?.compare;
  if (act === "watch" && cmp) return openSchedules({ kind: "compare", query: cmp.query, shops: cmp.shops, budget: cmp.budget });
  if (act !== "again") return;
  if (run.kind === "summary") return runSummary();
  if (run.kind === "compare" && cmp) return runCompare({ query: cmp.query, shops: cmp.shops, budget: cmp.budget });
  if (run.kind === "snapshot") return start("snapshot");
  startRun({ task: run.task });
});

/** "Ask about this page" under a summary: same tagged page text, same leak check. */
function addAskBox(run) {
  const input = h("textarea", { class: "input", rows: 1, placeholder: "Ask about this page — e.g. “Can I cancel any time?”" });
  const form = h(
    "form",
    {
      class: "followup ask",
      onsubmit: async (e) => {
        e.preventDefault();
        const question = input.value.trim();
        if (!question) return input.focus();
        if (busy()) return toast("Wait for the current task to finish");
        input.value = "";
        await askPage(run, question);
      },
    },
    input,
    h("button", { class: "btn primary sm", type: "submit" }, "Ask")
  );
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  run.el.append(form);
}

async function askPage(run, question) {
  const settings = await loadSettings();
  activeRun = run;
  selectRun(run);
  toolAbort = new AbortController();
  const signal = toolAbort.signal;
  setRunning(true);
  setRunStatus(run, "running");
  const box = h("div", { class: "qa" }, h("div", { class: "q" }, question), h("div", { class: "a" }, h("span", { class: "spinner sm" }), "Thinking…"));
  run.el.querySelector(":scope > .ask")?.before(box);
  glideTo(box);
  ui.status("Leak-checking your question and asking Gemini…");
  let ok = true;
  try {
    const out = await askAboutPage({ context: run.pageContext, question, settings, signal, rep: run.rep });
    box.querySelector(".a").replaceChildren(out.display, h("span", { class: "qa-meta" }, `${out.model} · tagged page text only · leak check passed`));
  } catch (e) {
    ok = false;
    box.querySelector(".a").replaceChildren(h("span", { class: "bad" }, signal.aborted ? "Stopped." : e.message || String(e)));
  }
  run.el.querySelector(":scope > .report")?.replaceWith(renderReport(run.rep));
  toolAbort = null;
  activeRun = null;
  setRunStatus(run, ok ? "done" : "stopped");
  setRunning(false);
  ui.status("");
}

// ------------------------------------------------------------------- toast

let toastTimer = 0;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  t.classList.remove("out");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.add("out");
    toastTimer = setTimeout(() => (t.hidden = true), 250);
  }, 1800);
}

// -------------------------------------------------------------------- home
// The start screen: connect Gemini, try a tool, re-run a recent task. It
// comes back when the last task tab is closed.

const home = $("#intro");
function hideHome() {
  home.hidden = true;
}
function showHome() {
  renderRecent();
  home.hidden = false;
}

async function refreshSetup() {
  const s = await loadSettings();
  $("#setupCard").hidden = !!s.apiKey || s.localBackup === "always";
}

$("#setupSave").addEventListener("click", async () => {
  const key = $("#setupKey").value.trim();
  const status = $("#setupStatus");
  if (!parseKeys(key).length) return (status.textContent = "Paste your key first.");
  status.className = "set-status";
  status.textContent = "Checking the key…";
  try {
    const { models } = await listModels(key);
    await saveSettings({ apiKey: key });
    status.className = "set-status ok";
    status.textContent = `✓ Connected — ${models.length} model${models.length === 1 ? "" : "s"} available.`;
    $("#setupKey").value = "";
    ui.status("");
    toast("Gemini connected");
    setTimeout(refreshSetup, 1200);
  } catch (err) {
    status.className = "set-status bad";
    status.textContent = `✗ ${err.message}`;
  }
});
$("#setupKey").addEventListener("keydown", (e) => e.key === "Enter" && $("#setupSave").click());

home.addEventListener("click", (e) => {
  const tryBtn = e.target.closest("[data-try]");
  if (tryBtn) {
    const what = tryBtn.dataset.try;
    if (what === "summary") return runSummary();
    if (what === "snapshot") return start("snapshot");
    if (what === "schedule") return openSchedules();
    if (what === "compare") {
      if (taskInput.value.trim()) return runCompare();
      setTask("boAt Airdopes 141 under 2000");
      taskInput.select();
      ui.status("Type the product you want (or keep the example), then press ⚖️ Compare prices.");
      $("#cmpBtn").classList.add("nudge");
      setTimeout(() => $("#cmpBtn").classList.remove("nudge"), 2400);
      return;
    }
  }
  const ex = e.target.closest("[data-task]");
  if (ex) {
    setTask(ex.dataset.task);
    taskInput.focus();
    ui.status("Press Run agent (or Ctrl+Enter) to start — edit the task first if you like.");
  }
});

// Recent tasks: the last few typed tasks, on this device only.
const RECENT_KEY = "stellar.recent";
function recentTasks() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}
function rememberTask(task) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([task, ...recentTasks().filter((t) => t !== task)].slice(0, 6)));
  } catch {
    /* storage unavailable */
  }
}
function renderRecent() {
  const list = recentTasks();
  $("#recentBox").hidden = !list.length;
  $("#recentList").replaceChildren(
    ...list.map((t) =>
      h(
        "div",
        { class: "recent-row" },
        h("button", { class: "recent-t", type: "button", title: "Put this task in the box", onclick: () => (setTask(t), taskInput.focus()) }, t),
        h("button", { class: "recent-run", type: "button", title: "Run it again", "aria-label": "Run again", onclick: () => startRun({ task: t }) }, "↻")
      )
    )
  );
}

// ---------------------------------------------------------------- composer
// The task box grows with its text; ↑ in an empty box recalls recent tasks;
// "/" anywhere focuses it.

function autoGrow() {
  taskInput.style.height = "auto";
  taskInput.style.height = `${Math.min(taskInput.scrollHeight + 2, 220)}px`;
}
function setTask(text) {
  taskInput.value = text;
  taskInput.dispatchEvent(new Event("input"));
}
taskInput.addEventListener("input", autoGrow);
let recallAt = -1;
taskInput.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return (recallAt = -1);
  const list = recentTasks();
  const recalling = recallAt >= 0 && taskInput.value === list[recallAt];
  if (!list.length || (taskInput.value && !recalling)) return;
  e.preventDefault();
  recallAt = e.key === "ArrowUp" ? Math.min(recallAt + 1, list.length - 1) : Math.max(recallAt - 1, -1);
  if (recallAt < 0) setTask("");
  else setTask(list[recallAt]);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.target.closest("input, textarea, select, [contenteditable]") && drawer.hidden && schedDrawer.hidden) {
    e.preventDefault();
    taskInput.focus();
  }
});

// ---------------------------------------------------------- scheduled tasks

const schedDrawer = $("#schedules");
const schedDays = $("#schedDays");
let editingSchedule = null;

// Monday first, like most calendars here.
schedDays.append(
  ...[1, 2, 3, 4, 5, 6, 0].map((d) => h("label", { class: "day" }, h("input", { type: "checkbox", value: String(d) }), h("span", {}, DAY_NAMES[d])))
);

function setDays(days) {
  schedDays.querySelectorAll("input").forEach((c) => (c.checked = days.includes(Number(c.value))));
}
function getDays() {
  return [...schedDays.querySelectorAll("input:checked")].map((c) => Number(c.value)).sort();
}
document.querySelectorAll("[data-days]").forEach((b) => b.addEventListener("click", () => setDays(b.dataset.days.split(",").map(Number))));

let schedPreset = null; // { kind: "compare", query, shops, budget } while setting up a price watch

function fillScheduleForm(s, preset = null) {
  editingSchedule = s?.id || null;
  schedPreset = s?.kind === "compare" ? { kind: "compare", query: s.query, shops: s.shops, budget: s.budget } : preset;
  const watch = !!schedPreset;
  $("#schedWatchNote").hidden = !watch;
  $("#schedTaskLabel").textContent = watch ? "Product" : "Task";
  for (const id of ["#schedModeField", "#schedUrlField", "#schedCloseField", "#schedSafeHint"]) $(id).hidden = watch;
  $("#schedTask").value = watch ? schedPreset.query : s?.task || "";
  $("#schedTime").value = s?.time || "09:00";
  setDays(s?.days || EVERY_DAY);
  $("#schedUrl").value = s?.startUrl || "";
  $("#schedClose").checked = s?.closeWhenDone !== false;
  (document.querySelector(`input[name=schedMode][value=${s?.mode === "autopilot" ? "autopilot" : "safe"}]`)).checked = true;
  $("#schedSave").textContent = editingSchedule ? "Save changes" : watch ? "Add price watch" : "Add schedule";
  $("#schedFormTitle").textContent = editingSchedule ? "Edit schedule" : watch ? "New price watch" : "New schedule";
}

async function openSchedules(preset = null) {
  // "Every morning at 9, check train ticket prices and tell me" fills the form.
  const typed = preset ? "" : taskInput.value.trim();
  const p = parseScheduleText(typed);
  fillScheduleForm(null, preset);
  if (preset) $("#schedTime").value = "09:00";
  if (typed) {
    $("#schedTask").value = p.task || typed;
    if (p.time) $("#schedTime").value = p.time;
    if (p.days) setDays(p.days);
  }
  $("#schedStatus").textContent = preset ? "Pick when to check — you'll get a notification with the cheapest price." : p.found ? "Filled in from what you typed — check it, then add." : "";
  renderSchedules();
  schedDrawer.hidden = false;
}

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

async function renderSchedules() {
  const box = $("#schedList");
  const list = await listSchedules();
  if (!list.length) {
    box.replaceChildren(h("p", { class: "set-hint" }, "No scheduled tasks yet."));
    return;
  }
  box.replaceChildren(
    ...list.map((s) =>
      h(
        "div",
        { class: `sched-row${s.enabled === false ? " paused" : ""}` },
        h(
          "div",
          { class: "sched-main" },
          h("b", {}, s.kind === "compare" ? `⚖️ Price watch: ${s.query}` : s.task),
          h("small", {}, `${describeWhen(s)}${s.kind === "compare" ? "" : ` · ${s.mode === "autopilot" ? "Autopilot" : "Safe"}`} · ${describeNext(s)}`),
          s.lastResult ? h("div", { class: `sched-last ${s.lastResult.ok ? "ok" : "bad"}` }, `${s.lastResult.ok ? "✓" : "✗"} ${ago(s.lastResult.at)}: ${s.lastResult.message.slice(0, 160)}`) : null
        ),
        h(
          "div",
          { class: "sched-actions" },
          h("button", { class: "btn ghost sm", type: "button", title: "Run it now in its own window", onclick: () => openRunner(s.id) }, "Run now"),
          h(
            "button",
            {
              class: "btn ghost sm",
              type: "button",
              onclick: async () => {
                await armSchedule(await updateSchedule(s.id, { enabled: s.enabled === false }));
                renderSchedules();
              },
            },
            s.enabled === false ? "Resume" : "Pause"
          ),
          h("button", { class: "btn ghost sm", type: "button", onclick: () => fillScheduleForm(s) }, "Edit"),
          h(
            "button",
            {
              class: "vf-del",
              type: "button",
              title: "Delete",
              onclick: async () => {
                await removeSchedule(s.id);
                if (editingSchedule === s.id) fillScheduleForm(null);
                renderSchedules();
              },
            },
            "×"
          )
        )
      )
    )
  );
}

$("#schedBtn").addEventListener("click", () => openSchedules());
$("#closeSchedules").addEventListener("click", () => (schedDrawer.hidden = true));
schedDrawer.addEventListener("click", (e) => {
  if (e.target === schedDrawer) schedDrawer.hidden = true;
});
$("#schedUseTab").addEventListener("click", async () => {
  const tab = await findTargetTab();
  if (/^https?:\/\//.test(tab?.url || "")) $("#schedUrl").value = tab.url;
  else $("#schedStatus").textContent = "The current tab isn't a web page.";
});

$("#schedSave").addEventListener("click", async () => {
  const status = $("#schedStatus");
  const task = $("#schedTask").value.trim();
  const days = getDays();
  let startUrl = $("#schedUrl").value.trim();
  if (!task) return (status.textContent = schedPreset ? "Write the product first." : "Write the task first.");
  if (!days.length) return (status.textContent = "Pick at least one day.");
  if (startUrl && !/^https?:\/\//i.test(startUrl)) startUrl = `https://${startUrl}`;
  if (startUrl) {
    try {
      new URL(startUrl);
    } catch {
      return (status.textContent = "That start page isn't a valid web address.");
    }
  }
  const s = {
    id: editingSchedule || crypto.randomUUID().slice(0, 8),
    task,
    time: $("#schedTime").value || "09:00",
    days,
    mode: document.querySelector("input[name=schedMode]:checked")?.value || "safe",
    startUrl,
    closeWhenDone: $("#schedClose").checked,
    enabled: true,
  };
  if (schedPreset) Object.assign(s, { kind: "compare", query: task, shops: schedPreset.shops, budget: schedPreset.budget ?? null, task: `Price watch: ${task}`, startUrl: "" });
  await upsertSchedule(s);
  toast(schedPreset ? "Price watch added" : "Schedule added");
  status.textContent = `Saved ✓ — ${describeNext(s).replace(/^Next: /, "next run ")}.`;
  fillScheduleForm(null);
  renderSchedules();
});

/** A scheduled run is waiting for approval or an answer: bring its window forward. */
function callUser(run) {
  chrome.notifications?.create(`stellar-wait-${run.id}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Stellar needs you",
    message: `A scheduled task is waiting for your approval or answer: ${run.task.slice(0, 120)}`,
    priority: 2,
  });
  chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, { focused: true, drawAttention: true })).catch(() => {});
}

let pendingRunMeta = null; // picked up by ui.runStarted for the next run

async function waitForLoad(tabId, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status === "complete") return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** This window was opened to run schedule `id`: run it beside the browser, then report. */
async function runScheduled(id) {
  const s = (await listSchedules()).find((x) => x.id === id);
  if (!s) return ui.status("This scheduled task no longer exists.");
  document.title = `⏰ ${s.task.slice(0, 40)} — Stellar`;
  await chrome.storage.session.set({ schedRunning: { id, at: Date.now() } }).catch(() => {});
  const meta = { id: Date.now(), title: `⏰ ${s.time}`, schedule: s };
  let win = null;
  try {
    // A price watch opens the stores in background tabs; a task gets a window of its own.
    if (s.kind === "compare") await runCompare({ query: s.query, shops: s.shops, budget: s.budget }, meta);
    else win = await runTaskInWindow(s, meta);
  } catch (e) {
    ui.status(`Couldn't start the scheduled task: ${e.message}`);
  }
  const run = ui.lastFinished;
  const ok = run?.status === "done";
  const message = run?.displayMessage || "The scheduled task didn't start.";
  await updateSchedule(id, { lastRun: Date.now(), lastResult: { ok, at: Date.now(), message: message.slice(0, 500) } });
  chrome.notifications.create(`stellar-done-${id}-${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: `${ok ? "✓" : "✗"} ${s.task.slice(0, 70)}`,
    message: message.slice(0, 300),
    priority: 1,
  });
  try {
    if (run) localStorage.setItem("stellar.selectedRun", String(run.id));
  } catch {
    /* storage unavailable */
  }
  if (win && ok && s.closeWhenDone !== false) chrome.windows.remove(win.id).catch(() => {});
  await chrome.storage.session.remove("schedRunning").catch(() => {});
  closeCountdown(90);
}

/** Run a scheduled agent task in a new browser window beside this one, so
 *  neither hides the other (Chrome slows down pages it can't see). */
async function runTaskInWindow(s, meta) {
  const me = await chrome.windows.getCurrent();
  const base = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const geo = base?.width > me.width + 600 ? { left: base.left, top: base.top, width: base.width - me.width, height: base.height } : {};
  const win = await createWindowAt({ url: s.startUrl || "https://www.google.com/", type: "normal", focused: true }, geo);
  const tabId = win.tabs[0].id;
  await waitForLoad(tabId);
  pendingRunMeta = meta;
  await startRun({ task: s.task, runMode: s.mode, startTabId: tabId });
  return win;
}

/** The runner window closes itself a little after the task, unless the user keeps it. */
function closeCountdown(secs) {
  const label = h("span", {}, "");
  const bar = h("div", { class: "close-bar" }, label, h("button", { class: "btn ghost sm", onclick: () => (clearInterval(timer), bar.remove()) }, "Keep open"));
  const tick = () => {
    label.textContent = `Done — this window closes in ${secs}s. The result is saved in the Stellar panel.`;
    if (secs-- <= 0) window.close();
  };
  const timer = setInterval(tick, 1000);
  tick();
  document.body.append(bar);
}

// ------------------------------------------------------------------- init

(async () => {
  const scheduledId = new URLSearchParams(location.search).get("scheduled");
  if (!scheduledId) restoreRuns();
  const s = await loadSettings();
  applyPresenter(s.presenter);
  applyTheme(s.theme || "system");
  applyRunMode(s.runMode);
  voiceLang.value = s.voiceLang || "auto";
  micBtn.hidden = voiceLang.hidden = !voiceSupported();
  configureAutoUnload(s.localUnloadMinutes ?? 10);
  // Warm the on-device model in the background once it has been downloaded.
  if (s.localBackup !== "off" && s.localPreload !== false && (await isLocalModelCached())) loadLocalModel().catch(() => {});
  renderRecent();
  refreshSetup();
  if (scheduledId) runScheduled(scheduledId);
})();
