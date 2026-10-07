// Side panel UI: renders each pipeline stage as it happens and wires settings.
// All page/model-derived strings go through textContent (never innerHTML).

import { StellarAgent, describeAction } from "./agent.js";
import { loadSettings, saveSettings, DEFAULTS } from "./settings.js";
import { listModels } from "./gemini.js";
import { CATEGORY_COLORS } from "./privacy.js";

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

let runLog = null;
let pending = [];

// ------------------------------------------------------------- utilities

function nearBottom() {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
}

function append(parent, node) {
  const stick = nearBottom();
  parent.append(node);
  if (stick) node.scrollIntoView({ block: "end", behavior: "smooth" });
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
        h("div", { class: "stat" }, h("b", {}, vision ? d.visionCount : "—"), h("span", {}, vision ? "Vision hits" : "Vision off")),
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
            "This stage stands in for the on-device detector, so the raw frame is sent to it. Switch to DOM-only in Settings to keep the frame local."
        )
      );
    }
    return card({ title: "Detect", badge: vision ? "mixed" : "local", badgeText: vision ? "local + vision" : "on-device", meta: `${d.ms} ms` }, ...body);
  },

  redact(d) {
    const uniq = uniqueRegions(d.regions);
    return card(
      { title: "Redact → semantic tags", badge: "local", badgeText: "on-device", meta: `${d.ms} ms` },
      shot(d.image, false),
      uniq.length ? h("div", { class: "tags" }, uniq.map((r) => tagChip(r.tag, r.category))) : h("div", { class: "note" }, "Nothing to mask."),
      h("div", { class: "note" }, `${d.elementCount} elements labelled for actions · ${d.style === "blur" ? "blur" : "solid"} masking`)
    );
  },

  send(d) {
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
    return card(
      { title: "Reason", badge: "cloud", badgeText: "cloud", meta: `${d.latencyMs} ms`, cloud: true },
      h("div", { class: "thought" }, h("b", {}, "Sees: "), d.decision?.observation || "—"),
      h("div", { class: "thought" }, h("b", {}, "Plans: "), d.decision?.thought || "—"),
      h("div", {}, h("span", { class: "action-pill" }, "⇢ ", describeAction(a))),
      a.final_answer && a.type !== "done" && a.type !== "ask_user" ? h("div", { class: "note" }, a.final_answer) : null,
      h("div", { class: "note" }, `${d.model} · ${usageText(d.usage)}${d.keyCount > 1 ? ` · key ${d.keyIndex}/${d.keyCount}` : ""}`),
      h("details", {}, h("summary", {}, "Model response (JSON)"), h("pre", {}, JSON.stringify(d.decision, null, 2)))
    );
  },

  validate(d) {
    const icon = { pass: "✓", warn: "!", confirm: "?", block: "✗" };
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

// ---------------------------------------------------------------------- ui

const ui = {
  runStarted({ task, snapshot, settings }) {
    $("#intro")?.remove();
    runLog = { task, mode: snapshot ? "snapshot" : "agent", startedAt: new Date().toISOString(), detector: settings.detector, reasonModel: settings.reasonModel, steps: [] };
    const head = h(
      "div",
      { class: "run-h" },
      h("div", { class: "lbl" }, snapshot ? "Snapshot" : "Task"),
      h("div", { class: "task" }, snapshot ? task || "Capture → Detect → Redact preview" : task)
    );
    append(feed, head);
    document.querySelector('[data-stage="detect"]').classList.toggle("cloud-assist", settings.detector === "vision");
    setRunning(true);
    this.status(snapshot ? "Taking a privacy snapshot…" : "Starting…");
  },

  beginStep(n) {
    const sec = h("section", { class: "step" }, h("div", { class: "step-h" }, `Step ${n}`));
    append(feed, sec);
    runLog.steps.push({ step: n, cards: [] });
    return sec;
  },

  setStage(stage) {
    const idx = STAGES.indexOf(stage);
    document.querySelectorAll("#pipeline li").forEach((li, i) => {
      li.classList.toggle("active", i === idx);
      li.classList.toggle("done", idx >= 0 && i < idx);
    });
  },

  card(S, stage, data) {
    const node = RENDER[stage](data);
    S.lastCard = node;
    append(S, node);
    runLog.steps[runLog.steps.length - 1].cards.push({ stage, ...exportable(stage, data) });
  },

  status(text) {
    statusLine.textContent = text;
    statusLine.classList.toggle("live", !!text);
  },

  confirm(S, reason) {
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
        resolve(v);
      };
      const cancel = () => done(false);
      pending.push(cancel);
      (S.lastCard?.querySelector(".card-b") || S).append(box);
      box.scrollIntoView({ block: "center", behavior: "smooth" });
      this.status("Waiting for your approval…");
    });
  },

  ask(S, question) {
    return new Promise((resolve) => {
      const input = h("textarea", { rows: 2, placeholder: "Your answer…" });
      const box = card(
        { title: "Agent asks", badge: "cloud", badgeText: "question", cloud: true },
        h("div", { class: "ask-box" }, h("div", {}, question), input),
        h(
          "div",
          { class: "row" },
          h("button", { class: "btn primary", onclick: () => done(input.value.trim() || "(no answer)") }, "Reply"),
          h("button", { class: "btn danger", onclick: () => done(null) }, "Stop")
        )
      );
      const done = (v) => {
        box.querySelector(".row")?.remove();
        input.disabled = true;
        pending = pending.filter((p) => p !== cancel);
        resolve(v);
      };
      const cancel = () => done(null);
      pending.push(cancel);
      append(S, box);
      input.focus();
      this.status("The agent is waiting for your answer…");
    });
  },

  cancelPending() {
    for (const p of [...pending]) p();
    pending = [];
  },

  finish({ ok, message }) {
    const box = h("div", { class: `final${ok ? "" : " bad"}` }, h("span", { class: "lbl" }, ok ? "Result" : "Stopped"), message);
    append(feed, box);
    if (runLog) runLog.result = { ok, message, finishedAt: new Date().toISOString() };
    this.setStage(null);
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
  if (agent.running) return;
  feed.replaceChildren();
  runLog = null;
});

$("#exportBtn").addEventListener("click", () => {
  if (!runLog) return ui.status("Nothing to export yet.");
  const blob = new Blob([JSON.stringify(runLog, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `stellar-run-${Date.now()}.json` });
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
  document.querySelector(`input[name=detector][value=${s.detector}]`).checked = true;
  document.querySelector(`input[name=redactStyle][value=${s.redactStyle}]`).checked = true;
  $("#askRisky").checked = s.askRisky;
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
    detector: document.querySelector("input[name=detector]:checked")?.value || "vision",
    redactStyle: document.querySelector("input[name=redactStyle]:checked")?.value || "solid",
    askRisky: $("#askRisky").checked,
    maxSteps: Math.max(1, Math.min(50, parseInt($("#maxSteps").value, 10) || 15)),
    vault: $("#vault").value,
  });
  $("#saveStatus").textContent = "Saved ✓";
  setTimeout(() => (drawer.hidden = true), 500);
});

// ------------------------------------------------------------------- init

(async () => {
  const s = await loadSettings();
  applyPresenter(s.presenter);
  document.querySelector('[data-stage="detect"]').classList.toggle("cloud-assist", s.detector === "vision");
  if (!s.apiKey) {
    ui.status("Add your Gemini API key in Settings (gear icon) to begin.");
  }
})();
