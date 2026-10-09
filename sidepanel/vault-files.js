// Private vault: stored documents (résumé, ID photo, …) for upload fields.
//
// Files live in this extension's IndexedDB on this device. The AI only ever
// sees a tag such as [FILE_RESUME] and the file's name/type; when it asks to
// upload one, the bytes go straight from here into the page's file input —
// never to the cloud model.

const DB = "stellar-vault-files";

let dbp = null;
function open() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files", { keyPath: "key" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction("files", mode);
    const req = fn(t.objectStore("files"));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

/** A short UPPERCASE key for a file, from its name and type. */
export function guessFileKey(file, taken = []) {
  const n = `${file.name} ${file.type}`.toLowerCase();
  let key =
    /resume|résumé|\bcv\b|curriculum/.test(n) ? "RESUME" :
    /cover.?letter/.test(n) ? "COVER_LETTER" :
    /aadhaar|aadhar|\bpan\b|passport|licen[cs]e|voter|\bid\b|id.?card/.test(n) ? "ID_CARD" :
    /photo|selfie|picture|portrait/.test(n) || /^image\//.test(file.type) ? "PHOTO" :
    /transcript|marksheet|mark.?sheet|grade/.test(n) ? "TRANSCRIPT" :
    /certificate/.test(n) ? "CERTIFICATE" :
    file.name.replace(/\.[^.]+$/, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "FILE";
  if (!taken.includes(key)) return key;
  for (let i = 2; ; i++) if (!taken.includes(`${key}_${i}`)) return `${key}_${i}`;
}

/** Metadata of every stored file (no bytes). */
export async function listFiles() {
  try {
    const all = (await tx("readonly", (s) => s.getAll())) || [];
    return all.map(({ key, name, type, size, addedAt }) => ({ key, name, type, size, addedAt })).sort((a, b) => a.addedAt - b.addedAt);
  } catch {
    return [];
  }
}

export async function putFile(key, file) {
  await tx("readwrite", (s) => s.put({ key, name: file.name, type: file.type || "application/octet-stream", size: file.size, blob: file, addedAt: Date.now() }));
}

export async function getFile(key) {
  return tx("readonly", (s) => s.get(key));
}

export async function deleteFile(key) {
  await tx("readwrite", (s) => s.delete(key));
}

export async function renameFile(oldKey, newKey) {
  if (oldKey === newKey) return;
  const rec = await getFile(oldKey);
  if (!rec) return;
  await tx("readwrite", (s) => {
    s.delete(oldKey);
    return s.put({ ...rec, key: newKey });
  });
}

/** Bytes of a stored file as base64, for handing to the page. */
export async function fileForUpload(key) {
  const rec = await getFile(key);
  if (!rec) return null;
  const bytes = new Uint8Array(await rec.blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { name: rec.name, type: rec.type, size: rec.size, b64: btoa(bin) };
}

export const fileTag = (key) => `[FILE_${key}]`;
export const fileKeyFromTag = (t) => String(t || "").replace(/^\[?FILE_|\]$/g, "").replace(/\]$/, "");
export const prettySize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
