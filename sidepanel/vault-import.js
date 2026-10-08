// Fill the private vault from the user's own documents (ID card photo, PDF,
// résumé, contact card…). Extraction runs on-device by default: pdf.js for
// text PDFs, FastVLM for images and scanned pages, rules for text formats.
// Gemini extraction is an explicit opt-in because it uploads the document.

import { askLocal } from "./local/vlm.js";
import { generateJson } from "./gemini.js";

export const VAULT_FIELDS = [
  "NAME", "FIRST_NAME", "LAST_NAME", "DOB", "GENDER", "EMAIL", "PHONE", "ADDRESS", "CITY", "STATE", "PINCODE",
  "COUNTRY", "COMPANY", "JOB_TITLE", "PAN", "AADHAAR", "PASSPORT", "ID_NUMBER",
];

// Document label -> vault key.
const ALIASES = [
  [/^(full\s*)?name$|^name of (the )?(applicant|holder|candidate)|^holder'?s? name|^applicant name|^candidate name/i, "NAME"],
  [/^first\s*name|^given\s*name/i, "FIRST_NAME"],
  [/^(last|sur|family)\s*name/i, "LAST_NAME"],
  [/^(date of birth|dob|d\.o\.b\.?|birth\s*date|born)$/i, "DOB"],
  [/^(gender|sex)$/i, "GENDER"],
  [/^(e-?mail|email address|e-mail id|email id)$/i, "EMAIL"],
  [/^(phone|mobile|mobile no\.?|phone number|contact( number| no\.?)?|tel(ephone)?)$/i, "PHONE"],
  [/^(address|residential address|permanent address|current address|street)$/i, "ADDRESS"],
  [/^(city|town)$/i, "CITY"],
  [/^(state|province)$/i, "STATE"],
  [/^(pin\s*code|pincode|postal code|zip( code)?)$/i, "PINCODE"],
  [/^(country|nationality)$/i, "COUNTRY"],
  [/^(company|organi[sz]ation|employer)$/i, "COMPANY"],
  [/^(job title|title|designation|role|position)$/i, "JOB_TITLE"],
  [/^(pan|pan no\.?|pan number|permanent account number)$/i, "PAN"],
  [/^(aadhaar|aadhar|aadhaar no\.?|aadhaar number|uid)$/i, "AADHAAR"],
  [/^(passport|passport no\.?|passport number)$/i, "PASSPORT"],
  [/^(id|id no\.?|id number|identity number|card number|document number)$/i, "ID_NUMBER"],
];

const PATTERNS = {
  EMAIL: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  PHONE: /(?:\+\d{1,3}[ -]?)?(?:\d[ -]?){9,12}\d/,
  PAN: /\b[A-Z]{5}\d{4}[A-Z]\b/,
  AADHAAR: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/,
  PINCODE: /\b\d{6}\b/,
  DOB: /\b(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2} [A-Za-z]{3,9} \d{4})\b/,
};

const JUNK = /^(n\/?a|none|nil|null|unknown|not (visible|available|provided|applicable|printed|shown)|-+|\.+|\?+|xxx+|\[.*\])$/i;

function canonicalKey(label) {
  const l = String(label).trim().replace(/[_]+/g, " ").replace(/\s+/g, " ");
  if (VAULT_FIELDS.includes(l.toUpperCase().replace(/ /g, "_"))) return l.toUpperCase().replace(/ /g, "_");
  for (const [re, key] of ALIASES) if (re.test(l)) return key;
  return null;
}

/** Drop values that are clearly not data, and ones that fail their own format check. */
function plausible(key, value) {
  const v = String(value || "").trim();
  if (!v || v.length > 200 || JUNK.test(v) || v.toUpperCase() === key) return false;
  if (key === "EMAIL") return PATTERNS.EMAIL.test(v);
  if (key === "PHONE") return /\d{7,}/.test(v.replace(/\D/g, "")) && v.replace(/\D/g, "").length <= 15;
  if (key === "PAN") return PATTERNS.PAN.test(v.toUpperCase());
  if (key === "AADHAAR") return v.replace(/\D/g, "").length === 12;
  if (key === "DOB") return /\d/.test(v);
  return true;
}

function addField(out, key, value, source) {
  key = key && VAULT_FIELDS.includes(key) ? key : null;
  if (!key) return;
  value = String(value).trim().replace(/\s+/g, " ").replace(/^[:\-–\s]+|[\s,;]+$/g, "");
  if (!plausible(key, value)) return;
  // Small vision models sometimes re-label one ID as another (e.g. part of an
  // ID number reported again as AADHAAR). Keep the first owner of those digits.
  const ID_KEYS = ["ID_NUMBER", "AADHAAR", "PAN", "PASSPORT"];
  if (ID_KEYS.includes(key)) {
    const digits = value.replace(/\W/g, "");
    if (out.some((f) => ID_KEYS.includes(f.key) && f.key !== key && (f.value.replace(/\W/g, "").includes(digits) || digits.includes(f.value.replace(/\W/g, ""))))) return;
  }
  if (out.some((f) => f.key === key && f.value.toLowerCase() === value.toLowerCase())) return;
  out.push({ key, value, source });
}

/** "Label: value" lines plus pattern sweeps — for any plain text. */
export function parseText(text, source) {
  const out = [];
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z][A-Za-z .'/()-]{1,40}?)\s*[:\-–]\s*(.+)$/);
    if (m) {
      addField(out, canonicalKey(m[1]), m[2], source);
      continue;
    }
    // Label on one line, value on the next (common on ID cards and forms).
    const key = canonicalKey(lines[i]);
    if (key && lines[i + 1] && !canonicalKey(lines[i + 1])) {
      addField(out, key, lines[i + 1], source);
      i++;
    }
  }
  const all = lines.join("\n");
  for (const key of ["EMAIL", "PAN", "AADHAAR", "PHONE"]) {
    if (out.some((f) => f.key === key)) continue;
    const m = all.match(PATTERNS[key]);
    if (m) addField(out, key, m[0], source);
  }
  if (!out.some((f) => f.key === "DOB")) {
    const m = all.match(/(?:birth|dob|d\.o\.b)[^\n\d]{0,20}([0-9][0-9/.\- A-Za-z]{6,18}\d)/i);
    if (m) addField(out, "DOB", m[1], source);
  }
  return out;
}

function parseVCard(text, source) {
  const out = [];
  const get = (re) => (text.match(re) || [])[1];
  addField(out, "NAME", get(/^FN[^:]*:(.+)$/im), source);
  addField(out, "EMAIL", get(/^EMAIL[^:]*:(.+)$/im), source);
  addField(out, "PHONE", get(/^TEL[^:]*:(.+)$/im), source);
  addField(out, "COMPANY", get(/^ORG[^:]*:(.+)$/im), source);
  addField(out, "JOB_TITLE", get(/^TITLE[^:]*:(.+)$/im), source);
  addField(out, "DOB", get(/^BDAY[^:]*:(.+)$/im), source);
  const adr = get(/^ADR[^:]*:(.+)$/im);
  if (adr) addField(out, "ADDRESS", adr.split(";").filter(Boolean).join(", "), source);
  return out;
}

function parseJson(text, source) {
  const out = [];
  const walk = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object") walk(v);
      else addField(out, canonicalKey(k.replace(/([a-z])([A-Z])/g, "$1 $2")), v, source);
    }
  };
  walk(JSON.parse(text));
  return out;
}

function parseCsv(text, source) {
  const rows = text.split(/\r?\n/).filter(Boolean).map((r) => r.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
  if (rows.length < 2) return parseText(text, source);
  const out = [];
  rows[0].forEach((h, i) => addField(out, canonicalKey(h), rows[1][i], source));
  return out;
}

// ---------------------------------------------------------------- DOCX
// A .docx is a zip; read word/document.xml with the browser's own inflater.
async function docxText(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid .docx file");
  let p = dv.getUint32(eocd + 16, true);
  const n = dv.getUint16(eocd + 10, true);
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
    if (name === "word/document.xml") {
      const lName = dv.getUint16(local + 26, true);
      const lExtra = dv.getUint16(local + 28, true);
      const data = new Uint8Array(buf, local + 30 + lName + lExtra, size);
      const xml =
        method === 0
          ? new TextDecoder().decode(data)
          : await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
      return xml
        .replace(/<\/w:p>/g, "\n")
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("No document text found in .docx");
}

// ---------------------------------------------------------------- PDF
let pdfjs = null;
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import("../vendor/pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
  return pdfjs;
}

async function pdfContent(buf, maxPages = 3) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  let text = "";
  const images = [];
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    // Rebuild lines from text items using their y position.
    let lastY = null;
    for (const it of tc.items) {
      const y = Math.round(it.transform[5]);
      text += lastY !== null && Math.abs(y - lastY) > 2 ? "\n" : it.str && text && !text.endsWith(" ") ? " " : "";
      text += it.str;
      lastY = y;
    }
    text += "\n";
    // Scanned page (little or no text layer): render it for the vision model.
    if (tc.items.map((x) => x.str).join("").trim().length < 30) {
      const vp = page.getViewport({ scale: 1.6 });
      const canvas = new OffscreenCanvas(vp.width, vp.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      images.push(await canvas.convertToBlob({ type: "image/png" }));
    }
  }
  return { text, images, pages: doc.numPages };
}

// ---------------------------------------------------------------- images
const VLM_PROMPT = `List every personal detail printed on this document, one per line, as LABEL: value.
Use these labels when they apply: NAME, DOB, GENDER, EMAIL, PHONE, ADDRESS, ID_NUMBER, PAN, AADHAAR, PASSPORT, COMPANY, JOB_TITLE.
Copy values exactly as printed. Skip anything that is not printed.`;

async function imageFieldsLocal(blob, source) {
  // Keep documents legible but bounded for the vision encoder.
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const png = await c.convertToBlob({ type: "image/png" });
  const r = await askLocal(png, VLM_PROMPT, 160);
  return { fields: parseText(r.text, source), ms: r.ms };
}

const GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: { fields: { type: "ARRAY", items: { type: "OBJECT", properties: { key: { type: "STRING", enum: VAULT_FIELDS }, value: { type: "STRING" } }, required: ["key", "value"] } } },
  required: ["fields"],
};

async function geminiFields({ blob, text, mimeType, apiKey, model, source }) {
  const toB64 = async (b) => {
    const bytes = new Uint8Array(await b.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const res = await generateJson({
    apiKey,
    model,
    prompt: `Extract the personal details printed in this document for the user's private vault. Only include values that are actually present.${text ? `\n\nDOCUMENT TEXT:\n${text.slice(0, 20000)}` : ""}`,
    image: blob ? { mimeType, base64: await toB64(blob) } : undefined,
    schema: GEMINI_SCHEMA,
    temperature: 0,
  });
  const out = [];
  for (const f of res.json?.fields || []) addField(out, f.key, f.value, source);
  return out;
}

/**
 * Extract vault fields from a File. `mode` is "local" (default) or "gemini".
 * Returns { fields: [{key, value, source}], method, note }.
 */
export async function extractFromFile(file, { mode = "local", apiKey, model } = {}) {
  const name = file.name || "file";
  const ext = (name.split(".").pop() || "").toLowerCase();
  const type = file.type || "";
  const isImage = type.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext);
  const isPdf = type === "application/pdf" || ext === "pdf";

  if (mode === "gemini") {
    if (isImage || isPdf) return { fields: await geminiFields({ blob: file, mimeType: isPdf ? "application/pdf" : type || "image/png", apiKey, model, source: name }), method: "Gemini (cloud)" };
    const text = ext === "docx" ? await docxText(await file.arrayBuffer()) : await file.text();
    return { fields: await geminiFields({ text, apiKey, model, source: name }), method: "Gemini (cloud)" };
  }

  if (isImage) {
    const r = await imageFieldsLocal(file, name);
    return { fields: r.fields, method: `on-device FastVLM (${(r.ms / 1000).toFixed(1)}s)` };
  }
  if (isPdf) {
    const { text, images, pages } = await pdfContent(await file.arrayBuffer());
    const fields = parseText(text, name);
    for (const img of images) for (const f of (await imageFieldsLocal(img, `${name} (scanned page)`)).fields) addField(fields, f.key, f.value, f.source);
    return { fields, method: images.length ? "on-device pdf.js + FastVLM" : "on-device pdf.js", note: pages > 3 ? "Only the first 3 pages were read." : "" };
  }
  if (ext === "docx") return { fields: parseText(await docxText(await file.arrayBuffer()), name), method: "on-device (.docx)" };
  const text = await file.text();
  if (ext === "vcf" || /^BEGIN:VCARD/i.test(text)) return { fields: parseVCard(text, name), method: "on-device (vCard)" };
  if (ext === "json") return { fields: parseJson(text, name), method: "on-device (JSON)" };
  if (ext === "csv") return { fields: parseCsv(text, name), method: "on-device (CSV)" };
  return { fields: parseText(text, name), method: "on-device (text)" };
}

/** Merge reviewed fields into the vault text, renaming clashes (EMAIL → EMAIL_2). */
export function mergeIntoVault(vaultText, fields) {
  const lines = String(vaultText || "").split(/\r?\n/).filter((l) => l.trim());
  const existing = new Map(lines.map((l) => [l.split("=")[0].trim().toUpperCase(), l.slice(l.indexOf("=") + 1).trim()]));
  let added = 0;
  for (const f of fields) {
    let key = f.key.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (existing.get(key)?.toLowerCase() === f.value.toLowerCase()) continue;
    for (let i = 2; existing.has(key); i++) key = `${f.key}_${i}`;
    existing.set(key, f.value);
    lines.push(`${key}=${f.value}`);
    added++;
  }
  return { text: lines.join("\n"), added };
}
