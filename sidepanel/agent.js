// The Stellar pipeline: Capture → Detect → Redact → Send → Reason → Validate → Execute.
// Runs in the side panel; reports every stage to the UI so the flow is visible.

import { generateJson } from "./gemini.js";
import { loadSettings } from "./settings.js";
import { DETECT_PROMPT, DETECT_SCHEMA, AGENT_SYSTEM, ACTION_SCHEMA, buildStepPrompt } from "./prompts.js";
import { buildRegions, parseVault, knownSecrets, scrubText, scrubUrl, leakCheck, coverage } from "./privacy.js";
import { loadBitmap, renderDetection, renderSanitized, encodeJpeg } from "./redact.js";
import { validateAction } from "./validate.js";

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

  // ------------------------------------------------------------------ run

  async run({ task, mode }) {
    this.settings = await loadSettings();
    this.stopped = false;
    this.running = true;
    this.abort = new AbortController();
    const { settings, ui } = this;
    const snapshot = mode === "snapshot";

    if (!settings.apiKey && (!snapshot || settings.detector === "vision")) {
      ui.finish({ ok: false, message: "Add your Gemini API key in Settings first." });
      this.running = false;
      return;
    }

    let tab = await findTargetTab();
    if (!tab || RESTRICTED_URL.test(tab.url || "")) {
      ui.finish({ ok: false, message: "Chrome does not allow extensions to read this page. Open a normal website tab and try again." });
      this.running = false;
      return;
    }
    let tabId = tab.id;
    const windowId = tab.windowId;
    const vault = parseVault(settings.vault);
    const history = [];
    const maxSteps = snapshot ? 1 : Math.max(1, Math.min(50, Number(settings.maxSteps) || 15));
    let consecutiveBlocks = 0;

    ui.runStarted({ task, snapshot, settings });

    try {
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
        ui.card(S, "capture", {
          ms: Math.round(performance.now() - t0),
          image: rawPreview.dataUrl,
          url: scan.url,
          title: scan.title,
          size: `${bitmap.width}×${bitmap.height}px`,
          viewport: scan.viewport,
          elementCount: scan.elements.length,
        });
        this.checkStop();

        // ----------------------------------------------------------- 2 DETECT
        ui.setStage("detect");
        const t1 = performance.now();
        let vision = [];
        let visionMeta = null;
        if (settings.detector === "vision") {
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
            throw new Error(
              `Vision detector failed (${e.message}). Stopping rather than sending a frame that was not fully checked. Retry, or switch the detector to "DOM only" in Settings.`
            );
          }
        }
        const regions = buildRegions({ domPii: scan.pii, vision, viewport: scan.viewport });
        const secrets = knownSecrets(regions, vault);
        const detectCanvas = renderDetection(bitmap, scan.viewport, regions);
        ui.card(S, "detect", {
          ms: Math.round(performance.now() - t1),
          mode: settings.detector,
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
          return { ...e, label };
        });
        const sanitizedCanvas = renderSanitized(bitmap, scan.viewport, regions, elements, { style: settings.redactStyle });
        const sanitized = encodeJpeg(sanitizedCanvas, 1280, 0.85);
        ui.card(S, "redact", {
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
        ui.card(S, "send", {
          payload: payloadPreview,
          prompt,
          image: sanitized.dataUrl,
          bytes: sanitized.bytes,
          leaks,
          secretCount: secrets.length,
          snapshot,
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
        let decision;
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
          ui.card(S, "reason", { model: res.model, latencyMs: res.latencyMs, usage: res.usage, decision, keyIndex: res.keyIndex, keyCount: res.keyCount });
        } catch (e) {
          if (this.stopped) throw new StopError();
          throw new Error(`Reasoning call failed: ${e.message}`);
        }
        const proposed = decision?.action || {};
        if (decision?.status) ui.status(decision.status);
        this.checkStop();

        if (proposed.type === "done") {
          ui.setStage(null);
          ui.finish({ ok: true, message: proposed.final_answer || decision.status || "Task complete." });
          return;
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
          ui.card(S, "validate", { verdict: v.verdict, checks: v.checks, reason: v.reason, pending: true, summary });
          await this.cs(tabId, { op: "overlay", visible: true, message: "Waiting for your approval in the Stellar panel" });
          approved = await ui.confirm(S, v.reason);
          this.checkStop();
          userNote = approved ? "approved by user" : "rejected by user";
        } else {
          ui.card(S, "validate", { verdict: v.verdict, checks: v.checks, reason: v.reason, summary });
        }

        if (v.verdict === "block" || !approved) {
          consecutiveBlocks++;
          const why = v.verdict === "block" ? `blocked by local validator: ${v.reason}` : "rejected by the user — choose a different approach or ask_user";
          history.push({ text: `Step ${step}: ${summary} → NOT EXECUTED (${why})`, sig: v.sig });
          ui.card(S, "execute", { skipped: true, detail: why });
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
        ui.card(S, "execute", { ms: Math.round(performance.now() - t3), ...result, summary, userNote });
        history.push({ text: `Step ${step}: ${summary} → ${result.ok ? "ok" : "FAILED"}: ${result.detail}`, sig: v.sig });
      }
      ui.finish({ ok: false, message: `Reached the step limit (${maxSteps}). Increase it in Settings or refine the task.` });
    } catch (e) {
      if (e instanceof StopError || this.stopped) ui.finish({ ok: false, message: "Stopped." });
      else ui.finish({ ok: false, message: e.message || String(e) });
    } finally {
      this.running = false;
      ui.setStage(null);
      try {
        await this.cs(tabId, { op: "overlay-remove" });
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
