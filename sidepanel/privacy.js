// Local privacy layer: merges DOM + vision detections into semantic tags,
// scrubs outbound text, substitutes tags back into actions, and checks the
// outbound payload for leaks. Nothing in here talks to the network.

const CATEGORY_ALIASES = {
  CREDIT_CARD: "CARD",
  CARD_NUMBER: "CARD",
  PERSON_NAME: "NAME",
  BANK_ACCOUNT: "ACCOUNT",
  PRIVATE_IMAGE: "IMAGE",
  OTHER_PII: "PII",
  SECRET: "API_KEY",
};

export const CATEGORY_COLORS = {
  PASSWORD: "#f43f5e",
  API_KEY: "#f43f5e",
  OTP: "#f43f5e",
  CVV: "#f43f5e",
  CARD: "#fb923c",
  ACCOUNT: "#fb923c",
  GOV_ID: "#fb923c",
  EMAIL: "#38bdf8",
  PHONE: "#38bdf8",
  ADDRESS: "#a78bfa",
  NAME: "#a78bfa",
  DOB: "#a78bfa",
  FACE: "#d946ef",
  IMAGE: "#d946ef",
  SIGNATURE: "#d946ef",
  PII: "#94a3b8",
};

export function normalizeCategory(c) {
  const up = String(c || "PII").toUpperCase().replace(/[^A-Z_]/g, "_");
  const mapped = CATEGORY_ALIASES[up] || up;
  return CATEGORY_COLORS[mapped] ? mapped : "PII";
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export function coverage(inner, outer) {
  const ix = Math.max(0, Math.min(inner.x + inner.w, outer.x + outer.w) - Math.max(inner.x, outer.x));
  const iy = Math.max(0, Math.min(inner.y + inner.h, outer.y + outer.h) - Math.max(inner.y, outer.y));
  const area = inner.w * inner.h;
  return area > 0 ? (ix * iy) / area : 0;
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Gemini box_2d is [ymin, xmin, ymax, xmax] normalised to 0..1000. */
export function box2dToRect(box, viewport) {
  const [ymin, xmin, ymax, xmax] = box.map(Number);
  const x = (Math.min(xmin, xmax) / 1000) * viewport.w;
  const y = (Math.min(ymin, ymax) / 1000) * viewport.h;
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round((Math.abs(xmax - xmin) / 1000) * viewport.w),
    h: Math.round((Math.abs(ymax - ymin) / 1000) * viewport.h),
  };
}

/**
 * Merge DOM and vision detections and assign stable semantic tags.
 * Identical DOM values share one tag, so the model sees a consistent
 * [EMAIL_01] wherever that address appears.
 */
export function buildRegions({ domPii = [], vision = [], viewport }) {
  const regions = [];

  for (const d of domPii) {
    const category = d.vaultTag ? normalizeCategory(d.vaultTag.replace(/^VAULT_/, "")) : normalizeCategory(d.category);
    const dup = regions.find((r) => iou(r.rect, d.rect) > 0.6);
    if (dup) continue;
    regions.push({ category, rect: d.rect, source: "dom", value: d.value, detail: d.detail, fixedTag: d.vaultTag });
  }

  for (const v of vision) {
    if (!Array.isArray(v.box_2d) || v.box_2d.length !== 4) continue;
    const rect = box2dToRect(v.box_2d, viewport);
    if (rect.w < 3 || rect.h < 3) continue;
    // Ignore absurd "redact the whole page" boxes; they destroy all context.
    if (rect.w * rect.h > viewport.w * viewport.h * 0.6) continue;
    const overlap = regions.find((r) => iou(r.rect, rect) > 0.3 || coverage(r.rect, rect) > 0.7 || coverage(rect, r.rect) > 0.7);
    if (overlap) {
      overlap.rect = union(overlap.rect, rect);
      if (overlap.source === "dom") overlap.source = "dom+vision";
      continue;
    }
    regions.push({ category: normalizeCategory(v.category), rect, source: "vision", detail: v.reason || "" });
  }

  regions.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const counters = {};
  const valueTags = new Map();
  for (const r of regions) {
    if (r.fixedTag) {
      r.tag = r.fixedTag;
      delete r.fixedTag;
      continue;
    }
    const key = r.value ? `${r.category}::${r.value}` : null;
    if (key && valueTags.has(key)) {
      r.tag = valueTags.get(key);
      continue;
    }
    counters[r.category] = (counters[r.category] || 0) + 1;
    r.tag = `${r.category}_${String(counters[r.category]).padStart(2, "0")}`;
    if (key) valueTags.set(key, r.tag);
  }
  return regions;
}

/** Parses the settings vault ("EMAIL=me@x.com" per line). */
export function parseVault(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9_ ]*?)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    out.push({ tag: `VAULT_${m[1].toUpperCase().replace(/\s+/g, "_")}`, value: m[2] });
  }
  return out;
}

const GENERIC_PATTERNS = [
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, "[API_KEY]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]"],
  [/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, "[NUMBER]"],
  [/(?<![\w+])(?:\+91[ -]?)?[6-9]\d{4}[ -]?\d{5}(?!\d)/g, "[PHONE]"],
  [/(?<!\w)\+\d{1,3}[ ().-]*\d{2,4}[ ().-]*\d{3,4}[ .-]*\d{3,4}(?!\d)/g, "[PHONE]"],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[GOV_ID]"],
];

/** Collect every concrete private value we know about locally. */
export function knownSecrets(regions, vault) {
  const out = [];
  const seen = new Set();
  for (const s of [...regions, ...vault]) {
    const key = `${s.tag}|${s.value}`;
    if (!s.value || s.value.length < 3 || seen.has(key)) continue;
    seen.add(key);
    out.push({ tag: s.tag, value: s.value });
  }
  // Longest first so substrings don't pre-empt full matches.
  return out.sort((a, b) => b.value.length - a.value.length);
}

/** Replace known private values with their tags, then sweep generic patterns. */
export function scrubText(text, secrets, { generic = true } = {}) {
  let s = String(text ?? "");
  for (const { tag, value } of secrets) s = s.split(value).join(`[${tag}]`);
  if (generic) for (const [re, repl] of GENERIC_PATTERNS) s = s.replace(re, repl);
  return s;
}

/** Scrub a URL: keep origin + path, drop query/fragment values. */
export function scrubUrl(url, secrets) {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.keys()];
    const q = params.length ? `?${params.map((k) => `${k}=…`).join("&")}` : "";
    return scrubText(`${u.origin}${u.pathname}${q}`, secrets);
  } catch {
    return scrubText(url, secrets);
  }
}

/** Which known secrets appear verbatim in the outbound text? */
export function leakCheck(outboundText, secrets) {
  return secrets.filter(({ value }) => outboundText.includes(value)).map((s) => s.tag);
}

/** Replace [TAG] references in model-authored text with local values. */
export function substituteTags(text, secrets) {
  const byTag = new Map(secrets.map((s) => [s.tag, s.value]));
  const substituted = [];
  const unresolved = [];
  const out = String(text ?? "").replace(/\[([A-Z][A-Z0-9_]*_\d{2}|VAULT_[A-Z0-9_]+)\]/g, (m, tag) => {
    if (byTag.has(tag)) {
      substituted.push(tag);
      return byTag.get(tag);
    }
    unresolved.push(tag);
    return m;
  });
  return { text: out, substituted, unresolved };
}
