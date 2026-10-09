// Local action-validation gate. The cloud model only *proposes* actions; this
// module decides whether each one is allowed, needs the user's approval, or is
// blocked, and resolves semantic tags to real values on-device.

import { ACTION_TYPES } from "./prompts.js";
import { substituteTags } from "./privacy.js";

const RISKY_WORDS =
  /\b(pay|payment|buy|purchase|place (your )?order|checkout|check out|transfer|send money|withdraw|delete|remove|erase|unsubscribe|deactivate|cancel (my )?(account|subscription)|confirm|submit|sign out|log ?out|donate|book now|post|publish|send)\b/i;

const TAG_IN_TEXT = /\[[A-Z][A-Z0-9_]*\]/;

// Page-detected categories whose values are credentials or identifiers.
const HIGH_RISK_TAG = /^(PASSWORD|API_KEY|OTP|CVV|CARD|ACCOUNT|GOV_ID)_\d+$/;

/**
 * @returns {{ verdict: "allow"|"confirm"|"block", checks: Array<{ok:boolean, level:string, label:string}>,
 *             action: object, displayText?: string, reason: string }}
 */
export async function validateAction(proposed, { inspect, elements, secrets, settings, history, vaultFiles = [] }) {
  const checks = [];
  const pass = (label) => checks.push({ ok: true, level: "pass", label });
  const warn = (label) => checks.push({ ok: true, level: "warn", label });
  // `hard` confirms are never auto-approved, even in Autopilot (they become blocks).
  const confirm = (label, hard = false) => checks.push({ ok: false, level: "confirm", label, hard });
  const block = (label) => checks.push({ ok: false, level: "block", label });

  const action = { ...(proposed || {}) };
  const sig = JSON.stringify([action.type, action.target, action.text, action.url, action.direction, action.key]);
  let displayText;

  if (!ACTION_TYPES.includes(action.type)) {
    block(`Unknown action type "${action.type}"`);
    return finish();
  }
  pass(`Action type "${action.type}" is on the allow-list`);

  // Loop guard: the same action proposed three times in a row.
  const lastSigs = history.slice(-2).map((h) => h.sig);
  if (action.type !== "scroll" && lastSigs.length === 2 && lastSigs.every((s) => s === sig)) {
    block("Same action proposed 3 times in a row — stopping a likely loop");
    return finish();
  }
  // Alternating loops (click A, scroll, click A, scroll, …).
  const repeats = history.slice(-8).filter((h) => h.sig === sig).length;
  if (!["scroll", "wait"].includes(action.type) && repeats >= 2) {
    block("This exact action was already tried twice in recent steps without progress — try a different approach, or use done/ask_user");
    return finish();
  }

  if (["click", "type", "select", "upload"].includes(action.type)) {
    if (!action.target) {
      block("No target element given");
      return finish();
    }
    action.target = String(action.target).replace(/^\[|\]$/g, "");
    const known = elements.find((e) => e.tag === action.target);
    if (!known) {
      block(`Target ${action.target} is not an interactive element from this turn's scan`);
      return finish();
    }
    pass(`Target ${action.target} maps to a real element ("${known.label}")`);

    const info = await inspect(action.target);
    if (!info?.exists || !info.connected) {
      block(`${action.target} is no longer attached to the page`);
      return finish();
    }
    if (!info.visible) {
      block(`${action.target} is not visible`);
      return finish();
    }
    if (info.disabled) {
      block(`${action.target} is disabled`);
      return finish();
    }
    if (info.inChallenge) {
      block(`${action.target} is part of a CAPTCHA / bot check — Stellar never solves those; the user must complete it`);
      return finish();
    }
    pass("Element is visible and enabled");

    if (action.type === "click" && (known.kind === "UPLOAD" || info.isUpload)) {
      block(`${action.target} is a file-upload field — clicking it opens the computer's file picker; use the upload action with a [FILE_…] tag instead`);
      return finish();
    }
    if (action.type === "upload") {
      if (!(known.kind === "UPLOAD" || info.isUpload)) {
        block(`${action.target} is not a file-upload field`);
        return finish();
      }
      const key = String(action.file || "").replace(/^\[?FILE_/, "").replace(/\]$/, "");
      const file = vaultFiles.find((f) => f.key === key);
      if (!file) {
        block(`No stored file [FILE_${key || "?"}] in the private vault${vaultFiles.length ? ` (have: ${vaultFiles.map((f) => `[FILE_${f.key}]`).join(", ")})` : " — add one in Settings → Private vault"}`);
        return finish();
      }
      action.file = key;
      displayText = `[FILE_${key}]`;
      pass(`[FILE_${key}] is ${file.name} — sent from this device straight to the page, never to the AI`);
      if (settings.askRisky) confirm(`Upload your file "${file.name}" to this website?`);
    }

    if (action.type === "type") {
      if (!info.editable) {
        block(`${action.target} is not a text field`);
        return finish();
      }
      const sub = substituteTags(action.text, secrets);
      if (sub.unresolved.length) {
        block(`Text references ${sub.unresolved.map((t) => `[${t}]`).join(", ")} which has no local value`);
        return finish();
      }
      displayText = String(action.text ?? "");
      if (sub.substituted.length) {
        const vaultTags = sub.substituted.filter((t) => t.startsWith("VAULT_"));
        const pageTags = sub.substituted.filter((t) => !t.startsWith("VAULT_"));
        pass(`Resolved ${sub.substituted.map((t) => `[${t}]`).join(", ")} locally — value never sent to the cloud`);
        if (vaultTags.length && settings.askRisky) {
          confirm(`Fill vault data (${vaultTags.map((t) => `[${t}]`).join(", ")}) into this page?`);
        }
        // Copying a secret that was *on the page* into a field is how data gets
        // pasted somewhere it shouldn't go (prompt injection, chat boxes, forms
        // that send it elsewhere). Always ask, whatever the risky-action setting.
        if (pageTags.length) {
          const list = pageTags.map((t) => `[${t}]`).join(", ");
          const critical = pageTags.filter((t) => HIGH_RISK_TAG.test(t));
          confirm(
            critical.length
              ? `Paste on-page secret ${list} into "${known.label}"? This copies a credential/ID value into the page${info.sensitive ? "" : " — and the field is not a password/secret field"}.`
              : `Copy on-page value ${list} into "${known.label}"?`,
            critical.length > 0 && !info.sensitive // credential into an ordinary field: classic exfiltration
          );
        }
      }
      action.text = sub.text;
      if (info.sensitive && !sub.substituted.length) {
        confirm("Model wants to type its own text into a sensitive field (password/card/OTP)");
      } else if (info.sensitive) {
        warn("Target is a sensitive field — filled from local data only");
      }
      if (action.submit && settings.askRisky && RISKY_WORDS.test(known.label)) {
        confirm(`Typing + Enter will submit "${known.label}"`);
      }
    }

    if (action.type === "click" && settings.askRisky) {
      const label = `${known.label} ${info.name || ""}`;
      if (RISKY_WORDS.test(label)) confirm(`"${known.label}" looks like an irreversible action`);
      else pass("No irreversible-action keywords on the target");
    }
  }

  if (action.type === "navigate") {
    let url;
    try {
      url = new URL(action.url);
    } catch {
      block(`Invalid URL "${action.url}"`);
      return finish();
    }
    if (!/^https?:$/.test(url.protocol)) {
      block(`Only http(s) navigation is allowed (got ${url.protocol})`);
      return finish();
    }
    if (TAG_IN_TEXT.test(decodeURIComponent(action.url))) {
      block("URL contains a semantic tag — tags are never substituted into URLs (exfiltration guard)");
      return finish();
    }
    pass(`Navigation target ${url.host} uses ${url.protocol.replace(":", "")}`);
  }

  if (action.type === "press_key") {
    const ok = ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Backspace", "Space"];
    if (!ok.includes(action.key || "Enter")) {
      block(`Key "${action.key}" is not allowed`);
      return finish();
    }
    pass(`Key ${action.key || "Enter"} is allowed`);
  }

  return finish();

  function finish() {
    // Autopilot: nothing waits for the user, except what is never safe to auto-approve.
    if (settings.autopilot) {
      for (const c of checks) {
        if (c.level !== "confirm") continue;
        if (c.hard) {
          c.level = "block";
          c.label = `${c.label} — blocked in Autopilot (switch to Safe mode to approve it yourself)`;
        } else {
          c.ok = true;
          c.level = "auto";
          c.label = `Auto-approved (Autopilot): ${c.label}`;
        }
      }
    }
    const verdict = checks.some((c) => c.level === "block") ? "block" : checks.some((c) => c.level === "confirm") ? "confirm" : "allow";
    const reason = checks.filter((c) => !c.ok).map((c) => c.label).join("; ");
    return { verdict, checks, action, displayText, reason, sig };
  }
}
