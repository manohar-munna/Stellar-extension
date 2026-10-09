// Privacy report: what was hidden on this device and what went to the cloud
// during one task, in plain words — "Hid 3 emails, 1 password and 2 names.
// Sent 0 private items to the cloud." No network, no DOM.

import { normalizeCategory } from "./privacy.js";

const ORDER = ["PASSWORD", "API_KEY", "OTP", "CVV", "CARD", "ACCOUNT", "GOV_ID", "EMAIL", "PHONE", "ADDRESS", "NAME", "DOB", "FACE", "SIGNATURE", "IMAGE", "PII"];

const NOUNS = {
  PASSWORD: ["password", "passwords"],
  API_KEY: ["API key", "API keys"],
  OTP: ["one-time code", "one-time codes"],
  CVV: ["CVV", "CVVs"],
  CARD: ["card number", "card numbers"],
  ACCOUNT: ["bank detail", "bank details"],
  GOV_ID: ["ID number", "ID numbers"],
  EMAIL: ["email", "emails"],
  PHONE: ["phone number", "phone numbers"],
  ADDRESS: ["address", "addresses"],
  NAME: ["name", "names"],
  DOB: ["date of birth", "dates of birth"],
  FACE: ["face", "faces"],
  SIGNATURE: ["signature", "signatures"],
  IMAGE: ["private image", "private images"],
  PII: ["other personal detail", "other personal details"],
};

export function newReport() {
  return {
    hidden: {}, // category -> Set of distinct items
    cloudRequests: 0, // requests that reached the cloud model
    leakChecks: 0, // of those, how many passed the outbound leak check
    leaksBlocked: 0, // requests stopped because a private value was in them
    bytes: 0, // sanitized screenshot bytes sent
    chars: 0, // tagged text characters sent
    localSteps: 0, // steps decided by the on-device model (nothing sent)
    rawFramesSent: 0, // unredacted screenshots sent to the cloud vision detector
    notes: [],
  };
}

/** [EMAIL_01] → EMAIL, [VAULT_PHONE] → PHONE, [NUMBER] → PII. */
export function categoryOfTag(tag) {
  const t = String(tag || "").replace(/^\[|\]$/g, "");
  if (t.startsWith("VAULT_")) {
    const k = t.slice(6);
    if (/NAME/.test(k)) return "NAME";
    if (/MAIL/.test(k)) return "EMAIL";
    if (/PHONE|MOBILE/.test(k)) return "PHONE";
    if (/ADDR|PIN|CITY|STREET/.test(k)) return "ADDRESS";
    if (/DOB|BIRTH/.test(k)) return "DOB";
    return normalizeCategory(k);
  }
  return normalizeCategory(t.replace(/_\d+$/, ""));
}

export function addHidden(rep, tag, key = tag) {
  const c = categoryOfTag(tag);
  (rep.hidden[c] ||= new Set()).add(key);
}

function joinAnd(parts) {
  return parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Counts per category, most sensitive first: [{ category, count, label }]. */
export function hiddenCounts(rep) {
  return ORDER.filter((c) => rep.hidden[c]?.size).map((c) => {
    const n = rep.hidden[c].size;
    return { category: c, count: n, label: NOUNS[c][n === 1 ? 0 : 1] };
  });
}

/** The two headline sentences and the supporting facts. */
export function reportText(rep) {
  const counts = hiddenCounts(rep);
  const hid = counts.length ? `Hid ${joinAnd(counts.map((c) => `${c.count} ${c.label}`))}.` : "Nothing private needed hiding.";
  let sent;
  let sentOk = true;
  if (rep.rawFramesSent) {
    sent = `${plural(rep.rawFramesSent, "unredacted screenshot")} went to the cloud vision detector.`;
    sentOk = false;
  } else if (!rep.cloudRequests) sent = "Sent nothing to the cloud.";
  else sent = "Sent 0 private items to the cloud.";

  const facts = [];
  if (rep.cloudRequests) {
    const what = [rep.bytes ? `${Math.round(rep.bytes / 1024)} KB of sanitized screenshots` : "", rep.chars ? `${rep.chars.toLocaleString()} characters of tagged text` : ""].filter(Boolean).join(" + ");
    facts.push({ ok: true, text: `${plural(rep.cloudRequests, "request")} to Gemini${what ? ` (${what})` : ""} — the leak check passed on ${rep.leakChecks === rep.cloudRequests ? (rep.cloudRequests === 1 ? "it" : "every one") : `${rep.leakChecks}`}.` });
  }
  if (rep.leaksBlocked) facts.push({ ok: false, text: `${plural(rep.leaksBlocked, "request")} stopped before sending because a private value was in it — nothing left the device.` });
  if (rep.localSteps) facts.push({ ok: true, text: `${plural(rep.localSteps, "step")} decided by the on-device model — nothing sent.` });
  if (rep.rawFramesSent) facts.push({ ok: false, text: "Cloud vision detection was on (Settings → Privacy), which sends the raw screenshot to find private data. Switch it to On-device to keep every screenshot on this computer." });
  else if (rep.bytes) facts.push({ ok: true, text: "Raw screenshots never left this computer — only the redacted copies." });
  for (const n of rep.notes) facts.push({ ok: true, text: n });
  return { hid, sent, sentOk, counts, facts };
}

/** Plain object for "Export run". */
export function reportJson(rep) {
  const t = reportText(rep);
  return {
    headline: `${t.hid} ${t.sent}`,
    hidden: Object.fromEntries(t.counts.map((c) => [c.category, c.count])),
    cloudRequests: rep.cloudRequests,
    leakChecksPassed: rep.leakChecks,
    leaksBlocked: rep.leaksBlocked,
    sanitizedBytes: rep.bytes,
    taggedChars: rep.chars,
    onDeviceSteps: rep.localSteps,
    unredactedScreenshotsSent: rep.rawFramesSent,
  };
}
