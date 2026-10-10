// The Stellar pipeline: Capture → Detect → Redact → Send → Reason → Validate → Execute.
// Runs in the side panel; reports every stage to the UI so the flow is visible.

import { generateJson } from "./gemini.js";
import { loadSettings, saveSettings } from "./settings.js";
import { mergeIntoVault, vaultFieldsFromPage, upsertVault } from "./vault-import.js";
import { DETECT_PROMPT, DETECT_SCHEMA, AGENT_SYSTEM, ACTION_SCHEMA, buildStepPrompt } from "./prompts.js";
import { buildRegions, parseVault, knownSecrets, nameSecrets, substitutionSecrets, scrubText, scrubUrl, leakCheck, coverage } from "./privacy.js";
import { loadBitmap, renderDetection, renderSanitized, encodeJpeg } from "./redact.js";
import { validateAction } from "./validate.js";
import { localDecide } from "./local/planner.js";
import { LOCAL_MODEL, holdLocalModel, loadLocalModel, isLocalModelCached, localState } from "./local/vlm.js";
import { detectFaces } from "./local/faces.js";
import { RealInput } from "./real-input.js";
import { baseOf, languageName } from "./voice.js";
import { listFiles, fileForUpload } from "./vault-files.js";

const NEW_TAB_URL = /^(chrome:\/\/(newtab|new-tab-page)|chrome-search:\/\/|about:blank|edge:\/\/newtab)/;

const RESTRICTED_URL =
  /^(chrome|edge|brave|about|chrome-extension|devtools|view-source|chrome-search):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class StopError extends Error {
  constructor() {
    super("Stopped by user");
  }
}

export function describeAction(a, displayText) {
  switch (a.type) {
    case "click":
      return `click [${a.target}]`;
    case "type":
    {
      const t = String(displayText ?? a.text ?? "");
      const lines = t.split("\n").length;
      const shown = lines > 1 || t.length > 90 ? `${t.split("\n")[0].slice(0, 60)}… (${lines} lines, ${t.length} chars)` : t;
      return `type "${shown}" into [${a.target}]${a.submit ? " + Enter" : ""}`;
    }
    case "upload":
      return `upload [FILE_${String(a.file || "").replace(/^\[?FILE_|\]$/g, "")}] to [${a.target}]`;
    case "select":
      return `select "${a.text}" in [${a.target}]`;
    case "scroll":
      return `scroll ${a.direction || "down"}${a.target ? ` in [${a.target}]` : ""}`;
    case "press_key":
      return `press ${a.key || "Enter"}`;
    case "navigate":
      return `navigate to ${a.url}`;
    case "go_back":
      return "go back";
    case "wait":
      return "wait for page";
    case "done":
      return "done";
    case "ask_user":
      return "ask user";
    default:
      return a.type;
  }
}

export class StellarAgent {
  constructor(ui) {
    this.ui = ui;
    this.running = false;
    this.stopped = false;
    this.abort = null;
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
    this.ui.cancelPending?.();
  }

  checkStop() {
    if (this.stopped) throw new StopError();
  }

  // ---------------------------------------------------------- tab plumbing

  async inject(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/content.js"] });
  }

  async cs(tabId, cmd) {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (c) => window.__stellar.handle(c),
      args: [cmd],
    });
    return res?.result;
  }

  /** Labelled personal details on the page → a "save to vault?" card (once per site per run). */
  async offerPageDetails(tabId, S, vault, url) {
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    this.vaultOffered ||= new Set();
    if (this.vaultOffered.has(host)) return;
    const pairs = await this.cs(tabId, { op: "fields" });
    const fields = vaultFieldsFromPage(pairs, (await loadSettings()).vault);
    if (!fields.length) return;
    this.vaultOffered.add(host);
    this.ui.offerVault(S, fields, {
      host,
      onSave: async (picked) => {
        const current = (await loadSettings()).vault;
        await saveSettings({ vault: upsertVault(current, picked).text });
        // Usable in this run straight away as [VAULT_…] tags.
        for (const f of picked) {
          const tag = `VAULT_${f.key}`;
          for (let i = vault.length - 1; i >= 0; i--) if (vault[i].tag === tag) vault.splice(i, 1);
          vault.push({ tag, value: f.value });
        }
      },
    });
  }

  async ensureActive(tabId) {
    const t = await chrome.tabs.get(tabId);
    if (!t.active) {
      await chrome.tabs.update(tabId, { active: true });
      await sleep(350);
    }
    return t;
  }

  async settle(tabId) {
    await sleep(700);
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      this.checkStop();
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t || t.status === "complete") break;
      await sleep(250);
    }
    await sleep(400);
  }

  /**
   * Pause for a CAPTCHA / bot check. Stellar never solves these; the user does,
   * and the run resumes by itself once the widget reports success (or the
   * interstitial page is gone), or when the user says so.
   */
  async waitForHuman(tabId, S, challenge, { op = "challenge", overlay, copy } = {}) {
    const { ui } = this;
    ui.setStage(null);
    await this.cs(tabId, { op: "overlay", visible: true, message: overlay || `Please complete the ${challenge.kind} — Stellar resumes automatically` }).catch(() => {});
    const handoff = ui.handoff(S, challenge.kind, copy);
    let outcome = null;
    handoff.done.then((v) => (outcome = outcome || v));
    const deadline = Date.now() + 5 * 60_000;
    while (!outcome) {
      if (this.stopped) {
        handoff.resolve("stop");
        throw new StopError();
      }
      if (Date.now() > deadline) {
        handoff.resolve("timeout");
        throw new Error(`Timed out after 5 minutes waiting for the ${challenge.kind} to be completed.`);
      }
      await sleep(1500);
      try {
        await this.inject(tabId);
        const c = await this.cs(tabId, { op });
        if (c && !c.pending) {
          outcome = "auto";
          handoff.resolve("auto");
        }
      } catch {
        /* page is navigating after the check — try again */
      }
    }
    if (outcome === "stop") throw new StopError();
    await this.settle(tabId);
    return outcome;
  }

  /**
   * Chrome only hands autofilled logins to the page after a trusted user
   * gesture, which synthetic DOM events are not. A real click (debugger
   * protocol) on a blank part of the form releases the values. Never used on
   * buttons, fields or CAPTCHAs — the point comes from the content script's
   * quiet-point search.
   * @returns {Promise<{x,y,on}|null>} the point clicked, when Chrome released the values
   */
  async unlockAutofill(tabId) {
    let pt;
    try {
      pt = await this.cs(tabId, { op: "quiet-point" });
    } catch {
      return null;
    }
    if (!pt || !(await this.real.attach(tabId))) return null;
    try {
      await this.real.click(pt.x, pt.y);
    } catch {
      return null;
    }
    for (let i = 0; i < 12; i++) {
      await sleep(150);
      const a = await this.cs(tabId, { op: "autofill" }).catch(() => null);
      if (a && !a.pending) return pt;
    }
    return null;
  }

  /**
   * Execute a validated action. With real input on (Settings → Agent), clicks,
   * typing and keys go through Chrome's real mouse and keyboard, which works on
   * React/Vue fields, rich-text editors, custom dropdowns and buttons that
   * ignore scripted events; scripted DOM events are the fallback. Points on a
   * CAPTCHA / bot check are refused outright — never clicked either way.
   */
  async perform(tabId, a) {
    const dom = async (action = a) => (await this.cs(tabId, { op: "execute", action })) || { ok: false, detail: "no response from page" };
    if (a.type === "upload") {
      const file = await fileForUpload(a.file);
      if (!file) return { ok: false, detail: `[FILE_${a.file}] is no longer in the vault` };
      return (await this.cs(tabId, { op: "upload", tag: a.target, file })) || { ok: false, detail: "no response from page" };
    }
    if (a.type === "type" && (await this.cs(tabId, { op: "inspect", tag: a.target }))?.editor) return this.typeIntoEditor(tabId, a);
    if (this.settings.realClick === false || !this.real.available || !["click", "type", "select", "press_key"].includes(a.type)) return dom();

    try {
      if (a.type === "press_key") {
        if (a.target) await this.cs(tabId, { op: "focus", tag: a.target });
        if (!(await this.real.attach(tabId))) return dom();
        await this.real.key(a.key || "Enter");
        return { ok: true, detail: `pressed ${a.key || "Enter"} (real keyboard)` };
      }

      // Native <select> popups can't be driven by mouse events; set those directly.
      if (a.type === "select" && (await this.cs(tabId, { op: "inspect", tag: a.target }))?.isSelect) return dom();

      const p = await this.cs(tabId, { op: "point", tag: a.target });
      if (!p?.ok) {
        if (p?.challenge) return { ok: false, detail: `${p.reason} — Stellar never clicks those` };
        return dom(); // covered or zero-size: try the scripted path
      }
      if (!(await this.real.attach(tabId))) return dom();
      await this.real.click(p.x, p.y);

      if (a.type === "click") return { ok: true, detail: `clicked ${a.target} (real mouse)` };
      if (a.type === "select") return { ok: true, detail: `opened ${a.target} (custom dropdown, real mouse)` };

      // type: the click focused the field; clear it, type, then check it took.
      await sleep(60);
      if (a.clear !== false) await this.real.clearFocused();
      await this.real.insertText(String(a.text ?? ""));
      await sleep(80);
      const back = await this.cs(tabId, { op: "readback", tag: a.target }).catch(() => null);
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9@]/g, "");
      if (!back?.exists || !norm(back.value).includes(norm(a.text))) {
        const r = await dom({ ...a, submit: false });
        if (!r.ok) return r;
      }
      if (a.submit) await this.real.key("Enter");
      return { ok: true, detail: `typed into ${a.target} (real keyboard)${a.submit ? " + Enter" : ""}` };
    } catch (e) {
      // Debugger unavailable mid-action (bar cancelled, page navigated): scripted fallback.
      if (/detached|not attached|Cannot access|No tab/i.test(e.message || "")) return dom();
      throw e;
    }
  }

  /**
   * Code editors (Monaco — LeetCode, VS Code web —, CodeMirror, Ace). First the
   * editor's own API in the page, which inserts the text exactly (no
   * auto-indent / auto-closing brackets doubling things up); if the page
   * doesn't expose it, a real click into the editor + select-all + real typing.
   */
  async typeIntoEditor(tabId, a) {
    const text = String(a.text ?? "");
    const clear = a.clear !== false;
    let api = null;
    try {
      [{ result: api }] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: setEditorText, args: [a.target, text, clear] });
    } catch (e) {
      api = { ok: false, why: e.message };
    }
    const lines = text.split("\n").length;
    if (api?.ok) return { ok: true, detail: `wrote ${lines} line(s) into the code editor (${api.via})` };

    if (this.settings.realClick === false || !this.real.available) return { ok: false, detail: `code editor: ${api?.why || "no editor API"}, and real keyboard is off (Settings → Agent)` };
    const p = await this.cs(tabId, { op: "point", tag: a.target });
    if (!p?.ok || !(await this.real.attach(tabId))) return { ok: false, detail: `code editor: ${p?.reason || "real keyboard unavailable"}` };
    await this.real.click(p.x, p.y);
    await sleep(100);
    // The editor shows only the lines in view; whatever it shows must be part of
    // the intended code (an auto-inserted extra "}" or a missing line fails this).
    const squash = (s) => String(s || "").replace(/\s+/g, "");
    const matches = async () => {
      await sleep(200);
      const back = squash((await this.cs(tabId, { op: "readback", tag: a.target }).catch(() => null))?.value);
      return back.length > 0 && squash(text).includes(back);
    };
    // 1) Paste — inserted verbatim, like a person pasting a solution.
    if (clear) await this.real.clearFocused();
    const pasted = await this.cs(tabId, { op: "paste", text }).catch(() => null);
    if (pasted?.handled && (await matches())) return { ok: true, detail: `pasted ${lines} line(s) into the code editor (real focus + paste)` };
    // 2) Real keystrokes — editors may auto-indent / auto-close brackets.
    await this.real.clearFocused();
    await this.real.insertText(text);
    if (await matches()) return { ok: true, detail: `typed ${lines} line(s) into the code editor (real keyboard)` };
    return { ok: false, detail: "typed into the code editor, but the editor changed the text (auto-indent / auto-closed brackets) — check the code" };
  }

  // ------------------------------------------------------------------ run

  // runMode / startTabId: a scheduled task's own Safe/Autopilot choice and the tab opened for it.
  async run({ task, mode, lang = "", spoken = false, continueRun = null, runMode = null, startTabId = null }) {
    this.settings = await loadSettings();
    if (runMode) this.settings.runMode = runMode;
    this.stopped = false;
    this.running = true;
    this.abort = new AbortController();
    this.real = new RealInput(); // attached on first real click/keystroke, detached when the run ends
    const { settings, ui } = this;
    const snapshot = mode === "snapshot";
    // "always": nothing goes to the cloud; the on-device model plans every step.
    const localOnly = settings.localBackup === "always";
    // "localfirst": the on-device model decides when it is confident; Gemini only otherwise.
    let localFirst = settings.localBackup === "localfirst" && !snapshot;
    // Autopilot: no approval prompts; only real questions (and CAPTCHAs) stop the run.
    settings.autopilot = settings.runMode === "autopilot";
    settings.askRisky = !settings.autopilot;

    const vault = parseVault(settings.vault);
    // A follow-up continues the same conversation: same run card, its history kept.
    const history = continueRun?.agentHistory || [];
    const vaultFiles = await listFiles();
    // Tags stay stable for the whole conversation (also across follow-ups).
    const tagMemory = continueRun?.tagMemory || { counters: {}, valueTags: new Map() };
    if (continueRun) continueRun.tagMemory = tagMemory;
    const maxSteps = snapshot ? 1 : Math.max(1, Math.min(50, Number(settings.maxSteps) || 15));
    let consecutiveBlocks = 0;
    const approvals = []; // two-step confirmations given in this run: { kind, step }
    const dismissedChecks = new Set(); // check kinds the user waved through this run
    let dismissedAutofill = false;
    const autofillTried = new Set(); // pages where the real-click unlock was tried
    let tabId = null;

    const { stepBase = 0 } = ui.runStarted({ task, snapshot, settings, maxSteps, lang, spoken, history, continueRun, tagMemory }) || {};
    if (continueRun) {
      // The shown result has people's names filled back in; tag them again
      // (and any other remembered value) before it becomes model context.
      let earlier = String(continueRun.finalMessage || "—");
      const remembered = [...(tagMemory.valueTags || [])].map(([key, tag]) => [key.slice(key.indexOf("::") + 2), tag]).filter(([v]) => v.length >= 3).sort((a, b) => b[0].length - a[0].length);
      for (const [value, tag] of remembered) earlier = earlier.split(value).join(`[${tag}]`);
      earlier = scrubText(earlier, knownSecrets([], vault));
      history.push({
        text: `The user follows up in the same conversation. Earlier task: "${continueRun.task}". Earlier result: "${earlier}". The TASK below is the follow-up; build on what was already done.`,
        sig: "followup",
      });
    }
    const foreign = !!lang && baseOf(lang) !== "en";
    // Never auto-unload the on-device model in the middle of a run.
    const holdModel = settings.localBackup !== "off" && !snapshot;
    if (holdModel) holdLocalModel(true);
    if (localOnly && !snapshot) loadLocalModel().catch(() => {}); // warm up while the first frame is captured
    if (localFirst) {
      if (localState.status === "ready" || (await isLocalModelCached())) loadLocalModel().catch(() => {});
      else {
        localFirst = false;
        ui.note(`Local-first: the on-device model isn't downloaded yet, so Gemini decides every step. Download it in Settings → On-device model.`);
      }
    }

    try {
      if (!settings.apiKey && !localOnly && (!snapshot || settings.detector === "vision")) {
        throw new Error("Add your Gemini API key in Settings first.");
      }

      // The on-device planner matches English words, so it gets an English copy
      // of a task given in another language (Gemini still sees the original).
      let localTask = task;
      if (foreign && !snapshot && (localFirst || localOnly) && settings.apiKey) {
        ui.status(`Translating the ${languageName(lang)} task for the on-device model…`);
        try {
          const res = await generateJson({
            apiKey: settings.apiKey,
            model: settings.detectModel || settings.reasonModel,
            prompt: `Translate this browser task into plain English for a keyword-based planner. Keep names, numbers, [TAGS] and any text the user wants typed or sent exactly as written, in its original language.\n\nTask: ${scrubText(task, knownSecrets([], vault), { generic: false })}`,
            schema: { type: "OBJECT", properties: { english: { type: "STRING" } }, required: ["english"] },
            temperature: 0,
            signal: this.abort.signal,
          });
          if (res.json?.english?.trim()) localTask = res.json.english.trim();
        } catch {
          /* the planner works from the original wording */
        }
      }

      let tab = startTabId != null ? await chrome.tabs.get(startTabId).catch(() => null) : await findTargetTab();
      if (tab && NEW_TAB_URL.test(tab.url || tab.pendingUrl || "")) {
        // Chrome blocks every extension on the New Tab page, so start from Google.
        if (snapshot) throw new Error("This is Chrome's New Tab page, which extensions can't read. Open any website and take the snapshot there.");
        ui.note("You're on Chrome's New Tab page, which extensions can't read — opening google.com in this tab to start.");
        await chrome.tabs.update(tab.id, { url: "https://www.google.com/" });
        await this.settle(tab.id);
        tab = await chrome.tabs.get(tab.id);
        history.push({
          text: "Step 0: the tab was Chrome's New Tab page (not automatable), so Stellar opened https://www.google.com/ to start.",
          sig: "start",
        });
      }
      if (!tab || RESTRICTED_URL.test(tab.url || "")) {
        throw new Error(
          `Chrome doesn't let extensions read this page${tab?.url ? ` (${tab.url.split("?")[0]})` : ""}. Switch to a website tab — or a New Tab, where Stellar will start from Google.`
        );
      }
      tabId = tab.id;
      let windowId = tab.windowId;
      // Tabs and pop-ups the run followed (e.g. a "Sign in with Google" window);
      // when one closes itself, the run carries on in the tab that opened it.
      const tabTrail = [];

      for (let step = stepBase + 1; step <= stepBase + maxSteps; step++) {
        this.checkStop();
        const S = ui.beginStep(step);

        let current = await chrome.tabs.get(tabId).catch(() => null);
        if (!current) {
          while (!current && tabTrail.length) {
            tabId = tabTrail.pop();
            current = await chrome.tabs.get(tabId).catch(() => null);
          }
          if (!current) throw new Error("The tab Stellar was working in was closed.");
          ui.note("The pop-up or tab Stellar was following closed itself (normal after signing in) — continuing in the page that opened it.");
          history.push({ text: `Step ${step}: the pop-up/tab from the previous step closed by itself; back on the page that opened it (${current.url?.split("?")[0] || "previous tab"}).`, sig: "tab-closed" });
          await this.settle(tabId);
        }
        windowId = current.windowId;

        // ---------------------------------------------------------- 1 CAPTURE
        ui.setStage("capture");
        await this.ensureActive(tabId);
        try {
          await this.inject(tabId);
        } catch (e) {
          throw new Error(`Cannot access this page (${e.message}). Some pages (Web Store, PDFs, chrome://) block extensions.`);
        }
        // Let the page finish drawing first: content that arrives after a
        // click (single-page sites, lazy thumbnails) belongs in the screenshot.
        const settled = await this.cs(tabId, { op: "settle", maxMs: step === stepBase + 1 ? 2500 : 4000 }).catch(() => null);
        this.checkStop();
        const t0 = performance.now();
        await this.cs(tabId, { op: "overlay", visible: false });
        await sleep(settled?.timedOut ? 300 : 80);
        let scan = await this.cs(tabId, { op: "scan", known: vault, names: settings.redactNames !== false });
        const rawDataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
        await this.cs(tabId, { op: "overlay", visible: true, message: snapshot ? "Stellar snapshot" : `Stellar · step ${step}` });
        const bitmap = await loadBitmap(rawDataUrl);
        const rawCanvas = toCanvas(bitmap);
        const rawPreview = encodeJpeg(rawCanvas, 900, 0.8);
        await ui.card(S, "capture", {
          ms: Math.round(performance.now() - t0),
          image: rawPreview.dataUrl,
          url: scan.url,
          title: scan.title,
          size: `${bitmap.width}×${bitmap.height}px`,
          viewport: scan.viewport,
          elementCount: scan.elements.length,
        });
        this.checkStop();

        // CAPTCHA / bot check on screen: hand over to the user, no model call.
        if (!snapshot && scan.challenge?.pending && !dismissedChecks.has(scan.challenge.kind)) {
          bitmap.close?.();
          const outcome = await this.waitForHuman(tabId, S, scan.challenge);
          // "Continue" while the check still looks pending = the user says there is
          // nothing to solve (or it can't be detected as solved): don't ask again.
          if (outcome === "manual") dismissedChecks.add(scan.challenge.kind);
          history.push({ text: `Step ${step}: a ${scan.challenge.kind} appeared and the user completed it by hand.`, sig: "human" });
          continue;
        }

        // Saved login autofilled by the browser: the values stay hidden from the
        // page and from Stellar until a real click on the page, so a synthetic
        // Sign-in would submit empty fields. One click by the user unlocks them.
        if (!snapshot && scan.autofill?.pending && !dismissedAutofill && settings.realClick !== false && !autofillTried.has(scan.url)) {
          // First choice: one real click on a blank part of the form, no user needed.
          autofillTried.add(scan.url);
          ui.status("Chrome is hiding the autofilled login — making one real click on a blank part of the form…");
          const unlocked = await this.unlockAutofill(tabId);
          if (unlocked) {
            ui.note(`Chrome had autofilled ${scan.autofill.fields.map((f) => `"${f}"`).join(", ")} but was hiding the values. Stellar made one real click on a blank part of the form (${unlocked.on}, at ${unlocked.x},${unlocked.y}) and Chrome released them — the password itself is never read or sent.`);
            history.push({ text: `Step ${step}: the browser's saved login was autofilled into ${scan.autofill.fields.join(", ")}; it is now usable. Treat these fields as filled — do not ask for them or retype them.`, sig: "autofill" });
            scan = await this.cs(tabId, { op: "scan", known: vault, names: settings.redactNames !== false });
          }
        }
        if (!snapshot && scan.autofill?.pending && !dismissedAutofill) {
          bitmap.close?.();
          const kind = "browser autofill";
          const outcome = await this.waitForHuman(tabId, S, { kind }, {
            op: "autofill",
            overlay: "Click once on an empty part of the page so Chrome hands over the autofilled login — Stellar resumes automatically",
            copy: {
              title: "Click the page once",
              body: `Chrome filled in ${scan.autofill.fields.map((f) => `"${f}"`).join(", ")} from your saved passwords, but keeps the values hidden from the site and from extensions until you click or type on the page yourself. Stellar's clicks don't count, so waiting won't help — click once on an empty part of the page.`,
              note: "Stellar never reads or stores the autofilled password. Already clicked and it didn't resume? Press Continue.",
              watching: "Watching the fields — resumes as soon as Chrome releases the values…",
              waiting: "Waiting for one click on the page…",
            },
          });
          if (outcome === "manual") dismissedAutofill = true;
          history.push({ text: `Step ${step}: the browser had autofilled ${scan.autofill.fields.join(", ")}; the user clicked the page so the values became usable. Treat these fields as filled — do not ask for them.`, sig: "human" });
          continue;
        }

        // ------------------------------------------- LABEL + ON-DEVICE DECISION
        // The frame only gets element tags here — no redaction — because it does
        // not leave the device. Detect → Redact → Send run only if the step has
        // to go to Gemini (PS 26171: sanitize before any network request).
        const tryLocal = !snapshot && (localFirst || localOnly);
        let decision = null;
        let localWhy = "";
        let elements;
        let secrets;
        let regions;
        if (tryLocal) {
          ui.setStage("reason");
          const labelled = scan.elements.map((e) => ({ ...e, label: e.name }));
          const labelledFrame = encodeJpeg(renderSanitized(bitmap, scan.viewport, [], labelled), 1280, 0.85);
          ui.status(`On-device ${LOCAL_MODEL.name} is looking at the labelled frame…`);
          let pick = null;
          try {
            await loadLocalModel();
            const imageBlob = await (await fetch(labelledFrame.dataUrl)).blob();
            const d = await localDecide({ task: localTask, elements: labelled, history, vault, vaultFiles, imageBlob, mode: localFirst ? "first" : "backup" });
            if (d.confident) pick = d;
            else localWhy = d.reason;
          } catch (err) {
            if (localOnly) throw new Error(`On-device model failed: ${err.message}`);
            localWhy = `on-device model unavailable (${err.message})`;
          }
          this.checkStop();
          if (pick) {
            const vaultSecrets = knownSecrets(nameSecrets(scan.names, tagMemory, vault), vault);
            // Step history can reach Gemini later, so labels are scrubbed of vault values and known patterns.
            elements = labelled.map((e) => ({ ...e, label: scrubText(e.name, vaultSecrets) }));
            secrets = vaultSecrets;
            regions = [];
            decision = pick;
            bitmap.close?.();
            ui.skipStages(S, ["detect", "redact", "send"]);
            await ui.card(S, "reason", { model: pick.model, latencyMs: pick.latencyMs, decision: pick, local: true, localFirst, localOnly, labelled: labelledFrame.dataUrl });
          }
        }

        if (!decision) {
        // ----------------------------------------------------------- 2 DETECT
        ui.setStage("detect");
        const t1 = performance.now();
        let vision = [];
        let visionMeta = null;
        if (settings.detector === "vision" && !localOnly) {
          const forDetect = encodeJpeg(rawCanvas, 1280, 0.85);
          try {
            const res = await generateJson({
              apiKey: settings.apiKey,
              model: settings.detectModel,
              prompt: DETECT_PROMPT,
              image: { mimeType: "image/jpeg", base64: forDetect.base64 },
              schema: DETECT_SCHEMA,
              temperature: 0,
              signal: this.abort.signal,
              onRetry: (ms) => ui.status(`Gemini is busy — retrying in ${Math.round(ms / 1000)}s…`),
            });
            vision = Array.isArray(res.json?.regions) ? res.json.regions : [];
            visionMeta = { model: res.model, latencyMs: res.latencyMs, usage: res.usage, bytes: forDetect.bytes, keyIndex: res.keyIndex, keyCount: res.keyCount };
          } catch (e) {
            if (this.stopped) throw new StopError();
            if (settings.localBackup === "off") {
              throw new Error(
                `Vision detector failed (${e.message}). Stopping rather than sending a frame that was not fully checked. Retry, or switch the detector to "DOM only" in Settings.`
              );
            }
            ui.note(`Vision detector unavailable (${e.message.slice(0, 120)}) — this frame is redacted with on-device detection only.`);
          }
        }
        // On-device vision: faces in the frame and inside every visible image.
        let faces = [];
        let faceMeta = null;
        try {
          const r = await detectFaces(bitmap, scan.viewport, scan.images || []);
          faces = r.faces;
          faceMeta = { count: r.faces.length, ms: r.ms };
        } catch (e) {
          ui.note(`On-device face detector unavailable (${String(e.message || e).slice(0, 100)}) — faces on this frame are not blurred.`);
        }
        regions = buildRegions({ domPii: scan.pii, vision, local: faces, viewport: scan.viewport, memory: tagMemory });
        // People's names that are only in labels/aria text get the same stable tags.
        secrets = knownSecrets([...regions, ...nameSecrets(scan.names, tagMemory, vault)], vault);
        const detectCanvas = renderDetection(bitmap, scan.viewport, regions);
        await ui.card(S, "detect", {
          ms: Math.round(performance.now() - t1),
          mode: localOnly || settings.detector !== "vision" ? "local" : "vision",
          faceMeta,
          domCount: scan.pii.length,
          visionCount: vision.length,
          visionMeta,
          regions,
          image: encodeJpeg(detectCanvas, 900, 0.8).dataUrl,
        });
        this.checkStop();
        // The user's own details shown on this page (a profile, an account
        // page): offer to keep them in the private vault. A quick local read;
        // the card itself doesn't wait for the user.
        if (settings.vaultFromPages !== false) await this.offerPageDetails(tabId, S, vault, scan.url).catch((e) => console.warn("[stellar] vault offer failed", e));

        // ----------------------------------------------------------- 3 REDACT
        ui.setStage("redact");
        const t2 = performance.now();
        elements = scan.elements.map((e) => {
          const cover = regions.find((r) => coverage(e.rect, r.rect) > 0.5);
          const label = cover && e.kind !== "INPUT" ? `[${cover.tag}]` : scrubText(e.name, secrets);
          const options = e.options?.map((o) => scrubText(o, secrets));
          return { ...e, label, ...(options ? { options, selected: scrubText(e.selected, secrets) } : {}) };
        });
        const sanitizedCanvas = renderSanitized(bitmap, scan.viewport, regions, elements);
        const sanitized = encodeJpeg(sanitizedCanvas, 1280, 0.85);
        await ui.card(S, "redact", {
          ms: Math.round(performance.now() - t2),
          image: sanitized.dataUrl,
          regions,
          elementCount: elements.length,
          policy: true,
        });
        bitmap.close?.();
        this.checkStop();

        // ------------------------------------------------------------- 4 SEND
        ui.setStage("send");
        const page = { title: scrubText(scan.title, secrets), url: scrubUrl(scan.url, secrets), viewport: scan.viewport };
        const prompt = buildStepPrompt({
          task: scrubText(task, secrets, { generic: false }),
          step,
          maxSteps,
          page,
          regions,
          vaultTags: vault.map((v) => v.tag),
          vaultFiles,
          elements,
          history: history.map((h) => scrubText(h.text, secrets)),
          userLang: foreign ? languageName(lang) : "",
        });
        const leaks = leakCheck(AGENT_SYSTEM + "\n" + prompt, secrets);
        const payloadPreview = {
          endpoint: `POST generativelanguage.googleapis.com/v1beta/models/${settings.reasonModel}:generateContent`,
          systemInstruction: `<Stellar agent rules — ${AGENT_SYSTEM.length} chars>`,
          contents: [
            {
              role: "user",
              parts: [
                { inline_data: { mime_type: "image/jpeg", data: `<sanitized screenshot ${sanitized.w}×${sanitized.h}, ${Math.round(sanitized.bytes / 1024)} KB>` } },
                { text: prompt },
              ],
            },
          ],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: "<action schema>" },
        };
        await ui.card(S, "send", {
          payload: payloadPreview,
          prompt,
          image: sanitized.dataUrl,
          bytes: sanitized.bytes,
          leaks,
          secretCount: secrets.length,
          snapshot,
          localOnly,
        });
        if (leaks.length) {
          throw new Error(`Leak check failed: ${leaks.map((t) => `[${t}]`).join(", ")} found in outbound text. Nothing was sent.`);
        }
        if (snapshot) {
          ui.finish({
            ok: true,
            message: `Snapshot complete — ${regions.length} private region(s) redacted, ${elements.length} elements tagged. Nothing was sent for reasoning.`,
          });
          return;
        }

        // ----------------------------------------------------------- 5 REASON
        ui.setStage("reason");
        await this.cs(tabId, { op: "overlay", visible: true, message: "Stellar is thinking…" });
        const decideLocally = async (why) => {
          if (why) ui.note(why);
          ui.status(`On-device ${LOCAL_MODEL.name} is choosing the next action…`);
          const imageBlob = await (await fetch(sanitized.dataUrl)).blob();
          try {
            return await localDecide({ task: localTask, elements, history, vault, vaultFiles, imageBlob });
          } catch (err) {
            throw new Error(`On-device model failed too: ${err.message}`);
          }
        };
        if (localOnly) {
          decision = await decideLocally();
          await ui.card(S, "reason", { model: decision.model, latencyMs: decision.latencyMs, decision, local: true, localOnly: true });
        } else {
          try {
            const res = await generateJson({
              apiKey: settings.apiKey,
              model: settings.reasonModel,
              system: AGENT_SYSTEM,
              prompt,
              image: { mimeType: "image/jpeg", base64: sanitized.base64 },
              schema: ACTION_SCHEMA,
              temperature: 0.2,
              signal: this.abort.signal,
              onRetry: (ms) => ui.status(`Gemini is busy — retrying in ${Math.round(ms / 1000)}s…`),
            });
            decision = res.json;
            await ui.card(S, "reason", { model: res.model, latencyMs: res.latencyMs, usage: res.usage, decision, keyIndex: res.keyIndex, keyCount: res.keyCount, whyCloud: localWhy });
          } catch (e) {
            if (this.stopped) throw new StopError();
            if (settings.localBackup === "off") throw new Error(`Reasoning call failed: ${e.message}`);
            decision = await decideLocally(`Gemini unavailable (${e.message.slice(0, 140)}) — the on-device ${LOCAL_MODEL.name} takes over this step.`);
            await ui.card(S, "reason", { model: decision.model, latencyMs: decision.latencyMs, decision, local: true, fallback: e.message });
          }
        }
        } // end of the redaction path (Detect → Redact → Send → Reason in the cloud)

        const proposed = decision?.action || {};
        if (decision?.status) ui.status(decision.status);
        this.checkStop();

        if (proposed.type === "done") {
          ui.setStage(null);
          // People's names come back for display only, here on this device —
          // Gemini wrote [NAME_03]; you read the name. Other tags stay tags.
          const nameOf = new Map();
          for (const [key, tag] of tagMemory.valueTags || []) if (key.startsWith("NAME::")) nameOf.set(tag, key.slice(6));
          const tagged = String(proposed.final_answer || decision.status || "Task complete.");
          const answer = tagged.replace(/\[(NAME_\d+)\]/g, (m, t) => nameOf.get(t) || m);
          ui.finish({ ok: true, message: answer, contextMessage: tagged });
          return;
        }
        const vaultKey = String(proposed.vault_key || "").toUpperCase().replace(/^VAULT_/, "").replace(/[^A-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
        if (proposed.type === "ask_user" && vaultKey) {
          ui.setStage(null);
          await this.cs(tabId, { op: "overlay", visible: true, message: "Stellar needs a detail from you" });
          const answer = await ui.askVault(S, proposed.final_answer || `What is your ${vaultKey.toLowerCase()}?`, vaultKey);
          if (answer == null) throw new StopError();
          const tag = `VAULT_${vaultKey}`;
          for (let i = vault.length - 1; i >= 0; i--) if (vault[i].tag === tag) vault.splice(i, 1);
          vault.push({ tag, value: answer.value });
          if (answer.save) {
            const current = (await loadSettings()).vault;
            await saveSettings({ vault: mergeIntoVault(current, [{ key: vaultKey, value: answer.value }]).text });
          }
          // The value itself never enters the history the cloud model sees.
          history.push({
            text: `Step ${step}: the user supplied [${tag}]${answer.save ? " (saved to the private vault)" : " (for this task only)"} — type [${tag}] where it is needed.`,
            sig: "vaultask",
            vaultKey,
          });
          continue;
        }
        if (proposed.type === "ask_user") {
          ui.setStage(null);
          await this.cs(tabId, { op: "overlay", visible: true, message: "Stellar is waiting for you" });
          const answer = await ui.ask(S, proposed.final_answer || "The agent needs your input.");
          if (answer == null) throw new StopError();
          history.push({
            text: `Step ${step}: asked the user "${proposed.final_answer}" → user answered: "${scrubText(answer, secrets, { generic: false })}"`,
            sig: "ask",
          });
          continue;
        }

        // --------------------------------------------------------- 6 VALIDATE
        ui.setStage("validate");
        const v = await validateAction(proposed, {
          inspect: (tag) => this.cs(tabId, { op: "inspect", tag }),
          elements,
          // Short vault answers ("3", "Yes") can be typed back too.
          secrets: substitutionSecrets(secrets, vault),
          settings,
          history,
          vaultFiles,
          approvals,
          step,
        });
        // v.action has a normalised target; displayText keeps tags instead of
        // the locally-substituted values, so summaries never contain secrets.
        const targetLabel = elements.find((e) => e.tag === v.action.target)?.label;
        const summary = describeAction(v.action, v.displayText) + (targetLabel ? ` ("${targetLabel}")` : "");
        let approved = v.verdict === "allow";
        let userNote = "";
        if (v.verdict === "confirm") {
          await ui.card(S, "validate", { verdict: v.verdict, checks: v.checks, reason: v.reason, pending: true, summary });
          await this.cs(tabId, { op: "overlay", visible: true, message: "Waiting for your approval in the Stellar panel" });
          approved = await ui.confirm(S, v.reason, { irreversible: v.irreversible, summary });
          this.checkStop();
          userNote = approved ? "approved by user" : "rejected by user";
          // A confirmed delete/payment covers the site's own follow-up steps for it.
          if (approved && v.irreversible) approvals.push({ kind: v.irreversible, step });
        } else {
          await ui.card(S, "validate", { verdict: v.verdict, checks: v.checks, reason: v.reason, summary });
        }

        if (v.verdict === "block" || !approved) {
          consecutiveBlocks++;
          const why = v.verdict === "block" ? `blocked by local validator: ${v.reason}` : "rejected by the user — choose a different approach or ask_user";
          history.push({ text: `Step ${step}: ${summary} → NOT EXECUTED (${why})`, sig: v.sig });
          await ui.card(S, "execute", { skipped: true, detail: why });
          if (consecutiveBlocks >= 3) throw new Error("Stopped after 3 consecutive blocked/rejected actions.");
          continue;
        }
        consecutiveBlocks = 0;

        // ---------------------------------------------------------- 7 EXECUTE
        ui.setStage("execute");
        const t3 = performance.now();
        await this.cs(tabId, { op: "overlay", visible: true, message: `Stellar · ${summary}` });
        let newTab = null;
        const onCreated = (t) => {
          if (t.openerTabId === tabId) newTab = t;
        };
        chrome.tabs.onCreated.addListener(onCreated);
        let result;
        try {
          const a = v.action;
          if (a.type === "navigate") {
            await chrome.tabs.update(tabId, { url: a.url });
            result = { ok: true, detail: `navigating to ${new URL(a.url).host}` };
          } else if (a.type === "go_back") {
            await chrome.tabs.goBack(tabId).catch(() => {});
            result = { ok: true, detail: "went back" };
          } else if (a.type === "wait") {
            await sleep(1500);
            result = { ok: true, detail: "waited 1.5s" };
          } else {
            result = await this.perform(tabId, a).catch((e) => {
              // A click that completes a sign-in often closes its own pop-up.
              if (/No tab with id|tab was closed|Frame with ID|No frame/i.test(e.message || "")) return { ok: true, detail: "done — the window closed after this action" };
              throw e;
            });
          }
          await this.settle(tabId);
        } finally {
          chrome.tabs.onCreated.removeListener(onCreated);
        }
        if (newTab) {
          tabTrail.push(tabId);
          tabId = newTab.id;
          await chrome.tabs.update(tabId, { active: true });
          await chrome.windows.update(newTab.windowId, { focused: true }).catch(() => {});
          await this.settle(tabId);
          result.detail += " (opened a new tab or pop-up — following it)";
        }
        await ui.card(S, "execute", { ms: Math.round(performance.now() - t3), ...result, summary, userNote });
        history.push({ text: `Step ${step}: ${summary} → ${result.ok ? "ok" : "FAILED"}: ${result.detail}`, sig: v.sig });
      }
      ui.finish({ ok: false, message: `Reached the step limit (${maxSteps}). Increase it in Settings or refine the task.` });
    } catch (e) {
      if (e instanceof StopError || this.stopped) ui.finish({ ok: false, message: "Stopped." });
      else ui.finish({ ok: false, message: e.message || String(e) });
    } finally {
      if (holdModel) holdLocalModel(false);
      await this.real.detach();
      this.running = false;
      ui.setStage(null);
      try {
        if (tabId != null) await this.cs(tabId, { op: "overlay-remove" });
      } catch {
        /* tab may be gone */
      }
    }
  }
}

// Runs in the page's own world (chrome.scripting, world MAIN) so it can reach
// the editor objects the page created. Self-contained: no outer references.
function setEditorText(tag, text, clear) {
  const root = document.querySelector(`[data-stellar-tag="${tag}"]`);
  if (!root) return { ok: false, why: "editor box not found" };
  try {
    const monaco = window.monaco;
    if (root.classList.contains("monaco-editor") && monaco?.editor) {
      const editors = monaco.editor.getEditors ? monaco.editor.getEditors() : [];
      const ed = editors.find((e) => e.getDomNode && (e.getDomNode() === root || root.contains(e.getDomNode()) || e.getDomNode().contains(root)));
      if (ed) {
        const model = ed.getModel();
        ed.pushUndoStop();
        if (clear) ed.executeEdits("stellar", [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }]);
        else ed.trigger("stellar", "type", { text });
        ed.pushUndoStop();
        ed.focus();
        return { ok: true, via: "Monaco API" };
      }
    }
    if (root.CodeMirror) {
      if (clear) root.CodeMirror.setValue(text);
      else root.CodeMirror.replaceSelection(text);
      return { ok: true, via: "CodeMirror API" };
    }
    const view = root.querySelector(".cm-content")?.cmView?.view;
    if (view) {
      view.dispatch({ changes: { from: 0, to: clear ? view.state.doc.length : 0, insert: text } });
      return { ok: true, via: "CodeMirror API" };
    }
    if (root.classList.contains("ace_editor") && window.ace) {
      const ed = window.ace.edit(root);
      if (clear) ed.setValue(text, 1);
      else ed.insert(text);
      return { ok: true, via: "Ace API" };
    }
  } catch (e) {
    return { ok: false, why: String(e?.message || e) };
  }
  return { ok: false, why: "the page doesn't expose the editor's API" };
}

// In the side panel the current window is the browser window being driven.
// When the panel is popped out into its own window, drive the active tab of
// the most recently focused normal browser window instead.
export async function findTargetTab() {
  let win = await chrome.windows.getCurrent();
  if (win.type !== "normal") win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  if (!win) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return tab || null;
}

function toCanvas(bitmap) {
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  c.getContext("2d").drawImage(bitmap, 0, 0);
  return c;
}
