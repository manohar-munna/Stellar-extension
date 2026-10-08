// On-device backup planner. Used when Gemini is unreachable (or in local-only
// mode). A 0.5B model cannot plan a whole task from scratch, so the extension
// does the structured part — candidate actions, relevance ranking, argument
// filling from the vault — and FastVLM makes the visual choice between the
// best candidates and writes free text. Output has the same shape as Gemini's.

import { askLocal, LOCAL_MODEL } from "./vlm.js";

const ELEMENT_TAG = /\[((?:INPUT|BUTTON|LINK|SELECT|CHECKBOX|RADIO|TAB|OPTION)_\d{2})\]/g;
const SUBMIT = /\b(send|submit|save|continue|next|confirm|search|apply|go|sign in|log ?in|done|finish|register|create)\b/i;
const DESTRUCTIVE = /\b(delete|remove|cancel|deactivate|sign out|log ?out|unsubscribe|rotate)\b/i;
const STOP = new Set("the and for with from that this your into about then them they have will what when which using use please also just make sure".split(" "));

// Field label -> vault keys to try, in order.
const FIELD_MAP = [
  [/user ?name|login|company name|business name/i, []],
  [/e-?mail/i, ["EMAIL", "EMAIL_ADDRESS"]],
  [/phone|mobile|\btel\b|contact number/i, ["PHONE", "MOBILE", "PHONE_NUMBER"]],
  [/first.?name|given name/i, ["FIRST_NAME", "NAME"]],
  [/last.?name|surname|family name/i, ["LAST_NAME", "SURNAME"]],
  [/\bname\b/i, ["NAME", "FULL_NAME"]],
  [/birth|\bdob\b/i, ["DOB", "DATE_OF_BIRTH"]],
  [/address|street/i, ["ADDRESS"]],
  [/city|town/i, ["CITY"]],
  [/\bstate\b|province/i, ["STATE"]],
  [/pin ?code|postal|\bzip\b/i, ["PINCODE", "POSTAL_CODE", "ZIP"]],
  [/country/i, ["COUNTRY"]],
  [/company|organi[sz]ation|employer/i, ["COMPANY"]],
  [/\bpan\b/i, ["PAN"]],
  [/aadhaar|aadhar/i, ["AADHAAR"]],
  [/passport/i, ["PASSPORT"]],
  [/gender|\bsex\b/i, ["GENDER"]],
];

const words = (t) => new Set((String(t).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w)));
const overlap = (a, b) => [...a].filter((w) => b.has(w)).length;

function vaultTagFor(label, vaultTags) {
  for (const [re, keys] of FIELD_MAP) {
    if (!re.test(label)) continue;
    for (const k of keys) if (vaultTags.includes(`VAULT_${k}`)) return `VAULT_${k}`;
    return null;
  }
  return null;
}

function actedTags(history) {
  const done = new Set();
  for (const h of history) {
    if (!/→ ok/.test(h.text)) continue;
    for (const m of h.text.matchAll(ELEMENT_TAG)) done.add(m[1]);
  }
  return done;
}

function searchQuery(task) {
  const m = task.match(/search(?:\s+\w+)?\s+for\s+["“']?(.+?)["”']?(?:,|\.|\s+and\s+|\s+then\s+|$)/i);
  return m ? m[1].trim() : null;
}

function describe(e) {
  if (e.kind === "INPUT") return `Type into "${e.label}"${e.filled ? " (filled)" : " (empty)"}`;
  if (e.kind === "SELECT") return `Choose an option in "${e.label}" (now: ${e.selected || "?"})`;
  if (e.kind === "CHECKBOX" || e.kind === "RADIO") return `Tick "${e.label}"`;
  return `Click "${e.label}"`;
}

/** Rank candidate actions for this step; higher is more relevant. */
export function rankCandidates({ task, elements, history, vaultTags }) {
  const tw = words(task);
  const acted = actedTags(history);
  const pendingInForm = new Map(); // form index -> fields still to handle

  const scored = elements
    .filter((e) => !e.disabled && !acted.has(e.tag))
    .map((e, idx) => {
      let score = overlap(words(e.label), tw) * 2;
      const vault = e.kind === "INPUT" ? vaultTagFor(e.label, vaultTags) : null;
      if (e.kind === "INPUT") {
        if (e.filled) score -= 5;
        if (vault && /vault|my |me\b|mine/i.test(task)) score += 3;
        if (/search/i.test(e.label) && searchQuery(task)) score += 3;
        if (/message|comment|description|details|note|reason/i.test(e.label) && /ask|say|tell|message|write|request|explain|mention/i.test(task)) score += 2;
        if (e.sensitive) score -= 2;
      }
      if (e.kind === "SELECT") {
        const optHit = Math.max(0, ...(e.options || []).map((o) => overlap(words(o), tw)));
        score += optHit * 2.5;
      }
      if (e.kind === "BUTTON" && SUBMIT.test(e.label)) score += 1;
      if (DESTRUCTIVE.test(e.label) && !overlap(words(e.label), tw)) score -= 4;
      if (e.kind === "LINK") score -= 0.5;
      const cand = { e, vault, score: score - idx * 0.01 };
      if ((e.kind === "INPUT" && !e.filled && score > 0) || (e.kind === "SELECT" && score > 0)) {
        if (e.form != null) pendingInForm.set(e.form, (pendingInForm.get(e.form) || 0) + 1);
      }
      return cand;
    });

  // Fill a form's relevant fields before clicking its submit button, and only
  // submit a form the agent has actually been filling in.
  const formsActed = new Set(elements.filter((e) => acted.has(e.tag) && e.form != null).map((e) => e.form));
  for (const c of scored) {
    if (!(c.e.kind === "BUTTON" && SUBMIT.test(c.e.label) && c.e.form != null)) continue;
    if (pendingInForm.get(c.e.form)) c.score -= 3;
    else if (formsActed.has(c.e.form)) c.score += 4;
    else c.score -= 1;
  }
  return scored.sort((a, b) => b.score - a.score);
}

function pickOption(options, task) {
  const tw = words(task);
  let best = null;
  let bestScore = 0;
  for (const o of options || []) {
    const s = overlap(words(o), tw);
    if (s > bestScore) {
      best = o;
      bestScore = s;
    }
  }
  return best;
}

function cleanText(t, task = "") {
  let s = String(t || "").trim();
  // "The text to type is "…"" -> keep only the quoted part.
  const quoted = s.match(/(?:is|:)\s*["“]([^"”]{4,})["”]\s*\.?$/);
  if (quoted) s = quoted[1];
  s = s
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/^(text|answer|message|reply)\s*:\s*/i, "")
    .trim()
    .slice(0, 400);
  // Reject a bare echo of the instruction.
  if (task && s.toLowerCase().replace(/\W/g, "") === task.toLowerCase().replace(/\W/g, "")) return "";
  return s;
}

/** Deterministic fallback message built from the task ("asking to X" -> "Hello, I would like to X."). */
function messageFromTask(task) {
  const m = task.match(/(?:asking|ask|request(?:ing)?|saying|say|telling|tell them|mention(?:ing)?)\s+(?:to\s+|that\s+)?(.+?)(?:,|\.|\s+and\s+(?:send|submit)|$)/i);
  if (!m) return "";
  const body = m[1].trim();
  // A statement ("my card was charged twice", "I cannot log in") is passed on as is;
  // a verb phrase ("downgrade my plan") becomes a request.
  if (/^(i|i'm|i've|my|our|we|the|it|there|this|that)\b/i.test(body)) return `Hello, ${body.replace(/^i\b/, "I")}. Thank you.`;
  return `Hello, I would like to ${body}. Thank you.`;
}

/**
 * Decide the next action on-device.
 * @returns {Promise<{observation, thought, status, action, local: true, model, latencyMs}>}
 */
export async function localDecide({ task, elements, history, vault, imageBlob }) {
  const t0 = performance.now();
  const vaultTags = vault.map((v) => v.tag);
  const ranked = rankCandidates({ task, elements, history, vaultTags });
  const viable = ranked.filter((c) => c.score > 0);
  const actedCount = actedTags(history).size;

  const finish = (answer, why) => ({
    observation: why,
    thought: "On-device backup planner found nothing relevant left to do.",
    status: "Finished (on-device backup)",
    action: { type: "done", final_answer: answer },
  });

  if (!viable.length) {
    return {
      ...finish(
        actedCount ? `Completed ${actedCount} action(s) with the on-device backup model. Please review the page.` : "The on-device backup model could not find a relevant action for this task on this page.",
        "No remaining element matches the task."
      ),
      local: true,
      model: LOCAL_MODEL.name,
      latencyMs: Math.round(performance.now() - t0),
    };
  }

  // FastVLM chooses among the top candidates while looking at the sanitized frame.
  // "Goal complete" is only an option once no strongly-matching action remains.
  const shortlist = viable.slice(0, 5);
  const canFinish = actedCount > 0 && !viable.some((c) => c.score >= 3);
  const q = `You are helping a user on a web page. Goal: ${task}
Already done: ${history.length ? history.slice(-6).map((h) => h.text.replace(/^Step \d+: /, "")).join("; ") : "nothing yet"}.
Which ONE action should happen next?
${shortlist.map((c, i) => `${i + 1}. ${describe(c.e)}`).join("\n")}${canFinish ? `\n${shortlist.length + 1}. The goal is complete` : ""}
Answer with the number only.`;
  let choice = shortlist[0];
  let vlmNote = "heuristic top choice";
  try {
    const r = await askLocal(imageBlob, q, 4);
    const n = parseInt((r.text.match(/\d+/) || [])[0], 10);
    if (n >= 1 && n <= shortlist.length) {
      choice = shortlist[n - 1];
      vlmNote = `FastVLM picked option ${n} of ${shortlist.length + 1}`;
    } else if (n === shortlist.length + 1 && canFinish) {
      return {
        ...finish(`Completed ${actedCount} action(s) with the on-device backup model.`, "FastVLM judged the goal complete."),
        local: true,
        model: LOCAL_MODEL.name,
        latencyMs: Math.round(performance.now() - t0),
      };
    }
  } catch (e) {
    vlmNote = `model unavailable (${e.message}) — used heuristic ranking`;
  }

  // Arguments for the chosen action.
  const e = choice.e;
  const action = { target: e.tag };
  if (e.kind === "INPUT") {
    action.type = "type";
    const q2 = /search/i.test(e.label) ? searchQuery(task) : null;
    if (choice.vault) action.text = `[${choice.vault}]`;
    else if (q2) {
      action.text = q2;
      action.submit = true;
    } else {
      // If the task already says what to write ("asking to X"), use that verbatim;
      // otherwise let FastVLM draft it.
      action.text = messageFromTask(task);
      if (!action.text) {
        try {
          const r = await askLocal(imageBlob, `The user wants to: ${task}
Write the short, polite text (one or two sentences) they would type into the "${e.label}" box, in their own voice. Output only that text.`, 70);
          action.text = cleanText(r.text, task);
        } catch {
          action.text = "";
        }
      }
      if (!action.text) action.text = task;
    }
  } else if (e.kind === "SELECT") {
    action.type = "select";
    let opt = pickOption(e.options, task);
    if (!opt && e.options?.length) {
      const opts = e.options.slice(0, 10);
      try {
        const r = await askLocal(imageBlob, `Goal: ${task}\nWhich option fits best for "${e.label}"?\n${opts.map((o, i) => `${i + 1}. ${o}`).join("\n")}\nAnswer with the number only.`, 4);
        const n = parseInt((r.text.match(/\d+/) || [])[0], 10);
        opt = opts[n - 1] || opts[0];
      } catch {
        opt = opts[0];
      }
    }
    action.text = opt || "";
  } else {
    action.type = "click";
  }

  return {
    observation: `On-device ${LOCAL_MODEL.name} looked at the sanitized frame (${vlmNote}).`,
    thought: `Candidates: ${shortlist.map((c) => `${c.e.tag} "${c.e.label}" (${c.score.toFixed(1)})`).join(", ")}`,
    status: `On-device backup: ${action.type} ${e.label}`,
    action,
    local: true,
    model: LOCAL_MODEL.name,
    latencyMs: Math.round(performance.now() - t0),
  };
}
