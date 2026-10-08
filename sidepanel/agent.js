// The Stellar pipeline: Capture → Detect → Redact → Send → Reason → Validate → Execute.
// Runs in the side panel; reports every stage to the UI so the flow is visible.

import { generateJson } from "./gemini.js";
import { loadSettings, saveSettings } from "./settings.js";
import { mergeIntoVault } from "./vault-import.js";
import { DETECT_PROMPT, DETECT_SCHEMA, AGENT_SYSTEM, ACTION_SCHEMA, buildStepPrompt } from "./prompts.js";
import { buildRegions, parseVault, knownSecrets, scrubText, scrubUrl, leakCheck, coverage } from "./privacy.js";
import { loadBitmap, renderDetection, renderSanitized, encodeJpeg } from "./redact.js";
import { validateAction } from "./validate.js";
import { localDecide } from "./local/planner.js";
import { LOCAL_MODEL, holdLocalModel, loadLocalModel, isLocalModelCached, localState } from "./local/vlm.js";
import { detectFaces } from "./local/faces.js";

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
      return `type "${displayText ?? a.text ?? ""}" into [${a.target}]${a.submit ? " + Enter" : ""}`;
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
   * gesture, which synthetic DOM events are not. A click sent through the
   * debugger protocol goes through Chrome's real input pipeline, so one click
   * on a blank part of the form releases the values. The debugger is attached
   * only for that click. Never used on buttons, fields or CAPTCHAs — the point
   * comes from the content script's quiet-point search.
   * @returns {Promise<{x,y,on}|null>} the point clicked, when Chrome released the values
   */
  async unlockAutofill(tabId) {
    if (!chrome.debugger) return null;
    let pt;
    try {
      pt = await this.cs(tabId, { op: "quiet-point" });
    } catch {
      return null;
    }
    if (!pt) return null;
    const target = { tabId };
    try {
      await chrome.debugger.attach(target, "1.3");
      const send = (type, extra = {}) => chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, ...extra });
      await send("mouseMoved");
      await send("mousePressed", { button: "left", buttons: 1, clickCount: 1 });
      await send("mouseReleased", { button: "left", buttons: 0, clickCount: 1 });
    } catch {
      return null;
    } finally {
      await chrome.debugger.detach(target).catch(() => {});
    }
    for (let i = 0; i < 12; i++) {
      await sleep(150);
      const a = await this.cs(tabId, { op: "autofill" }).catch(() => null);
      if (a && !a.pending) return pt;
    }
    return null;
  }

  // ------------------------------------------------------------------ run

  async run({ task, mode }) {
    this.settings = await loadSettings();
    this.stopped = false;
    this.running = true;
    this.abort = new AbortController();
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
    const history = [];
    const maxSteps = snapshot ? 1 : Math.max(1, Math.min(50, Number(settings.maxSteps) || 15));
    let consecutiveBlocks = 0;
    const dismissedChecks = new Set(); // check kinds the user waved through this run
    let dismissedAutofill = false;
    const autofillTried = new Set(); // pages where the real-click unlock was tried
    let tabId = null;

    ui.runStarted({ task, snapshot, settings, maxSteps });
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

      let tab = await findTargetTab();
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
      const windowId = tab.windowId;

      for (let step = 1; step <= maxSteps; step++) {
        this.checkStop();
        const S = ui.beginStep(step);

        // ---------------------------------------------------------- 1 CAPTURE
        ui.setStage("capture");
        await this.ensureActive(tabId);
        try {
          await this.inject(tabId);
        } catch (e) {
          throw new Error(`Cannot access this page (${e.message}). Some pages (Web Store, PDFs, chrome://) block extensions.`);
        }
        const t0 = performance.now();
        await this.cs(tabId, { op: "overlay", visible: false });
        await sleep(40);
        let scan = await this.cs(tabId, { op: "scan", known: vault });
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
            scan = await this.cs(tabId, { op: "scan", known: vault });
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
            const d = await localDecide({ task, elements: labelled, history, vault, imageBlob, mode: localFirst ? "first" : "backup" });
            if (d.confident) pick = d;
            else localWhy = d.reason;
          } catch (err) {
            if (localOnly) throw new Error(`On-device model failed: ${err.message}`);
            localWhy = `on-device model unavailable (${err.message})`;
          }
          this.checkStop();
          if (pick) {
            const vaultSecrets = knownSecrets([], vault);
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
        regions = buildRegions({ domPii: scan.pii, vision, local: faces, viewport: scan.viewport });
        secrets = knownSecrets(regions, vault);
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
          elements,
          history: history.map((h) => scrubText(h.text, secrets)),
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
            return await localDecide({ task, elements, history, vault, imageBlob });
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
          ui.finish({ ok: true, message: proposed.final_answer || decision.status || "Task complete." });
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
          secrets,
          settings,
          history,
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
          approved = await ui.confirm(S, v.reason);
          this.checkStop();
          userNote = approved ? "approved by user" : "rejected by user";
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
            result = (await this.cs(tabId, { op: "execute", action: a })) || { ok: false, detail: "no response from page" };
          }
          await this.settle(tabId);
        } finally {
          chrome.tabs.onCreated.removeListener(onCreated);
        }
        if (newTab) {
          tabId = newTab.id;
          await chrome.tabs.update(tabId, { active: true });
          await this.settle(tabId);
          result.detail += " (opened a new tab — following it)";
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

// In the side panel the current window is the browser window being driven.
// When the panel is popped out into its own window, drive the active tab of
// the most recently focused normal browser window instead.
async function findTargetTab() {
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
