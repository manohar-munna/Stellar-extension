// The Stellar pipeline: Capture → Detect → Redact → Send → Reason → Validate → Execute.
// Runs in the side panel; reports every stage to the UI so the flow is visible.

import { generateJson } from "./gemini.js";
import { loadSettings } from "./settings.js";
import { DETECT_PROMPT, DETECT_SCHEMA, AGENT_SYSTEM, ACTION_SCHEMA, buildStepPrompt } from "./prompts.js";
import { buildRegions, parseVault, knownSecrets, scrubText, scrubUrl, leakCheck, coverage } from "./privacy.js";
import { loadBitmap, renderDetection, renderSanitized, encodeJpeg } from "./redact.js";
import { validateAction } from "./validate.js";
import { localDecide } from "./local/planner.js";
import { LOCAL_MODEL } from "./local/vlm.js";
import { startEpisode, addExample, endEpisode } from "./training.js";

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
  async waitForHuman(tabId, S, challenge) {
    const { ui } = this;
    ui.setStage(null);
    await this.cs(tabId, { op: "overlay", visible: true, message: `Please complete the ${challenge.kind} — Stellar resumes automatically` }).catch(() => {});
    const handoff = ui.handoff(S, challenge.kind);
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
        const c = await this.cs(tabId, { op: "challenge" });
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

    const vault = parseVault(settings.vault);
    const history = [];
    const maxSteps = snapshot ? 1 : Math.max(1, Math.min(50, Number(settings.maxSteps) || 15));
    let consecutiveBlocks = 0;
    let tabId = null;
    // Training-data recorder (Settings → Training data). Never allowed to break a run.
    let episode = null;
    let pendingRec = null;
    let outcome = null;
    const finishRun = (o) => {
      outcome = o;
      ui.finish(o);
    };
    const record = async (extra) => {
      if (!episode || !pendingRec) return;
      const rec = { ...pendingRec, ...extra };
      pendingRec = null;
      try {
        await addExample(episode, rec);
      } catch (err) {
        console.warn("[stellar] training record failed", err);
      }
    };

    ui.runStarted({ task, snapshot, settings, maxSteps });

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
      if (settings.collectTraining && !snapshot && !localOnly) {
        try {
          episode = await startEpisode({ host: hostOf(tab.url), source: settings.trainingSource || "user" });
        } catch (err) {
          console.warn("[stellar] training episode failed", err);
        }
      }
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
        const scan = await this.cs(tabId, { op: "scan", known: vault });
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
        if (!snapshot && scan.challenge?.pending) {
          bitmap.close?.();
          await this.waitForHuman(tabId, S, scan.challenge);
          history.push({ text: `Step ${step}: a ${scan.challenge.kind} appeared and the user completed it by hand.`, sig: "human" });
          continue;
        }

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
        const regions = buildRegions({ domPii: scan.pii, vision, viewport: scan.viewport });
        const secrets = knownSecrets(regions, vault);
        const detectCanvas = renderDetection(bitmap, scan.viewport, regions);
        await ui.card(S, "detect", {
          ms: Math.round(performance.now() - t1),
          mode: localOnly ? "dom" : settings.detector,
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
        const elements = scan.elements.map((e) => {
          const cover = regions.find((r) => coverage(e.rect, r.rect) > 0.5);
          const label = cover && e.kind !== "INPUT" ? `[${cover.tag}]` : scrubText(e.name, secrets);
          const options = e.options?.map((o) => scrubText(o, secrets));
          return { ...e, label, ...(options ? { options, selected: scrubText(e.selected, secrets) } : {}) };
        });
        const sanitizedCanvas = renderSanitized(bitmap, scan.viewport, regions, elements, { style: settings.redactStyle });
        const sanitized = encodeJpeg(sanitizedCanvas, 1280, 0.85);
        await ui.card(S, "redact", {
          ms: Math.round(performance.now() - t2),
          image: sanitized.dataUrl,
          regions,
          elementCount: elements.length,
          style: settings.redactStyle,
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
          history: history.map((h) => h.text),
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
          finishRun({
            ok: true,
            message: `Snapshot complete — ${regions.length} private region(s) redacted, ${elements.length} elements tagged. Nothing was sent for reasoning.`,
          });
          return;
        }

        // ----------------------------------------------------------- 5 REASON
        ui.setStage("reason");
        await this.cs(tabId, { op: "overlay", visible: true, message: "Stellar is thinking…" });
        let decision;
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
            if (episode) {
              pendingRec = {
                step,
                image: sanitized.dataUrl,
                task: scrubText(task, secrets, { generic: false }),
                host: hostOf(scan.url),
                viewport: { w: scan.viewport.w, h: scan.viewport.h },
                elements: elements.map((e) => ({
                  tag: e.tag, kind: e.kind, label: e.label, inputType: e.inputType, filled: e.filled, checked: e.checked,
                  disabled: e.disabled, sensitive: e.sensitive, options: e.options, selected: e.selected, form: e.form, rect: e.rect,
                })),
                history: history.map((h) => h.text),
                vaultTags: vault.map((v) => v.tag),
                hiddenTags: [...new Set(regions.map((r) => r.tag))],
                model: res.model,
                decision: { observation: decision?.observation, thought: decision?.thought, action: decision?.action },
              };
            }
            await ui.card(S, "reason", { model: res.model, latencyMs: res.latencyMs, usage: res.usage, decision, keyIndex: res.keyIndex, keyCount: res.keyCount });
          } catch (e) {
            if (this.stopped) throw new StopError();
            if (settings.localBackup === "off") throw new Error(`Reasoning call failed: ${e.message}`);
            decision = await decideLocally(`Gemini unavailable (${e.message.slice(0, 140)}) — the on-device ${LOCAL_MODEL.name} takes over this step.`);
            await ui.card(S, "reason", { model: decision.model, latencyMs: decision.latencyMs, decision, local: true, fallback: e.message });
          }
        }
        const proposed = decision?.action || {};
        if (decision?.status) ui.status(decision.status);
        this.checkStop();

        if (proposed.type === "done") {
          await record({ kind: "done", executed: true, resultOk: true, verdict: "allow" });
          ui.setStage(null);
          finishRun({ ok: true, message: proposed.final_answer || decision.status || "Task complete." });
          return;
        }
        if (proposed.type === "ask_user") {
          await record({ kind: "ask", executed: false });
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
          await record({ kind: "action", executed: false, verdict: v.verdict, approved });
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
        await record({ kind: "action", executed: true, resultOk: !!result.ok, verdict: v.verdict, approved, newTab: !!newTab });
      }
      finishRun({ ok: false, message: `Reached the step limit (${maxSteps}). Increase it in Settings or refine the task.` });
    } catch (e) {
      if (e instanceof StopError || this.stopped) finishRun({ ok: false, message: "Stopped." });
      else finishRun({ ok: false, message: e.message || String(e) });
    } finally {
      if (episode) {
        try {
          await endEpisode(episode, outcome || { ok: false, message: "ended" });
        } catch (err) {
          console.warn("[stellar] training episode end failed", err);
        }
        this.lastEpisode = episode;
      }
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

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function toCanvas(bitmap) {
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  c.getContext("2d").drawImage(bitmap, 0, 0);
  return c;
}
