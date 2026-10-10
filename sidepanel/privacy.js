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
export function buildRegions({ domPii = [], vision = [], local = [], viewport, memory = null }) {
  const regions = [];

  for (const d of domPii) {
    const category = d.vaultTag ? normalizeCategory(d.vaultTag.replace(/^VAULT_/, "")) : normalizeCategory(d.category);
    const dup = regions.find((r) => iou(r.rect, d.rect) > 0.6);
    if (dup) continue;
    regions.push({ category, rect: d.rect, source: "dom", value: d.value, detail: d.detail, fixedTag: d.vaultTag });
  }

  // On-device vision detections (e.g. faces) arrive as CSS-pixel rects.
  for (const d of local) {
    const rect = d.rect;
    if (!rect || rect.w < 3 || rect.h < 3) continue;
    const overlap = regions.find((r) => iou(r.rect, rect) > 0.3 || coverage(r.rect, rect) > 0.7 || coverage(rect, r.rect) > 0.7);
    if (overlap) {
      overlap.rect = union(overlap.rect, rect);
      continue;
    }
    regions.push({ category: normalizeCategory(d.category), rect, source: "on-device vision", detail: d.detail || "" });
  }

  for (const v of vision) {
    if (!Array.isArray(v.box_2d) || v.box_2d.length !== 4) continue;
    // Only faces and personal data are hidden — never a whole picture.
    if (/^(?:PRIVATE_)?IMAGE$|^PHOTO$/i.test(String(v.category || ""))) continue;
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
  // With a run-wide memory, a value keeps its tag on every step ([NAME_02] is
  // the same person throughout the task), so the model's context stays coherent.
  const counters = memory ? (memory.counters ||= {}) : {};
  const valueTags = memory ? (memory.valueTags ||= new Map()) : new Map();
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
  // Forms often ask for first and last name separately; derive them from NAME.
  const name = out.find((v) => v.tag === "VAULT_NAME" || v.tag === "VAULT_FULL_NAME");
  const parts = name ? name.value.trim().split(/\s+/) : [];
  if (parts.length >= 2) {
    if (!out.some((v) => v.tag === "VAULT_FIRST_NAME")) out.push({ tag: "VAULT_FIRST_NAME", value: parts.slice(0, -1).join(" "), derived: true });
    if (!out.some((v) => v.tag === "VAULT_LAST_NAME")) out.push({ tag: "VAULT_LAST_NAME", value: parts[parts.length - 1], derived: true });
  }
  return out;
}

/**
 * Tags for people's names found on the page (also those only in labels or
 * aria text), from the run-wide memory so a person keeps one tag all task.
 * The user's own vault values keep their [VAULT_…] tags.
 */
export function nameSecrets(names = [], memory, vault = []) {
  const out = [];
  if (!memory) return out;
  memory.counters ||= {};
  memory.valueTags ||= new Map();
  for (const n of names) {
    if (!n || n.length < 3 || vault.some((v) => v.value === n)) continue;
    const key = `NAME::${n}`;
    let tag = memory.valueTags.get(key);
    if (!tag) {
      memory.counters.NAME = (memory.counters.NAME || 0) + 1;
      tag = `NAME_${String(memory.counters.NAME).padStart(2, "0")}`;
      memory.valueTags.set(key, tag);
    }
    out.push({ tag, value: n });
  }
  return out;
}

/**
 * Values that can be typed back in for a tag: everything known, including very
 * short vault answers ("3", "Yes") that are too short to scrub from text safely.
 */
export function substitutionSecrets(secrets, vault) {
  const out = [...secrets];
  for (const v of vault) if (v.value && !out.some((s) => s.tag === v.tag)) out.push({ tag: v.tag, value: v.value });
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

/** scrubText that also says what it replaced: [{ tag, key }] (key is unique per value). */
export function scrubWithReport(text, secrets, { generic = true } = {}) {
  let s = String(text ?? "");
  const found = [];
  for (const { tag, value } of secrets) {
    const parts = s.split(value);
    if (parts.length > 1) found.push({ tag, key: tag });
    s = parts.join(`[${tag}]`);
  }
  if (generic) {
    for (const [re, repl] of GENERIC_PATTERNS) {
      s = s.replace(re, (m) => {
        found.push({ tag: repl.slice(1, -1), key: `${repl}${m}` });
        return repl;
      });
    }
  }
  return { text: s, found };
}

/**
 * Tags for private values the content script found in page text
 * ({category, vaultTag, value}); one tag per distinct value, longest first.
 */
export function tagTextHits(hits, memory) {
  memory.counters ||= {};
  memory.valueTags ||= new Map();
  const out = new Map();
  for (const h of hits) {
    if (!h.value || h.value.length < 3 || out.has(h.value)) continue;
    if (h.vaultTag) {
      out.set(h.value, h.vaultTag);
      continue;
    }
    const category = normalizeCategory(h.category);
    const key = `${category}::${h.value}`;
    let tag = memory.valueTags.get(key);
    if (!tag) {
      memory.counters[category] = (memory.counters[category] || 0) + 1;
      tag = `${category}_${String(memory.counters[category]).padStart(2, "0")}`;
      memory.valueTags.set(key, tag);
    }
    out.set(h.value, tag);
  }
  return [...out].map(([value, tag]) => ({ tag, value })).sort((a, b) => b.value.length - a.value.length);
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
