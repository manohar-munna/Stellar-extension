// Panel-side client for the on-device VLM worker.

export const LOCAL_MODEL = { id: "onnx-community/FastVLM-0.5B-ONNX", name: "FastVLM-0.5B", approxMB: 670 };

let worker = null;
let seq = 0;
const calls = new Map();
const listeners = new Set();
export const localState = { status: "idle", device: null, loadMs: null, error: null, progress: 0, unloadedAfterMin: null };

// ---------------------------------------------------------- auto-unload
// A loaded model holds ~4 GB of RAM and ~2 GB of GPU memory. After a period
// with no use it is unloaded by terminating its worker (which releases all of
// it at once); the next request reloads it from the browser cache.
let unloadMs = 10 * 60_000;
let idleTimer = null;
let holds = 0; // >0 while a run that may need the model is in progress
let lastUsed = 0;

function emit() {
  for (const fn of listeners) fn({ ...localState });
}

export function onLocalState(fn) {
  listeners.add(fn);
  fn({ ...localState });
  return () => listeners.delete(fn);
}

function armIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!unloadMs || holds || calls.size || localState.status !== "ready") return;
  const wait = Math.max(1000, unloadMs - (Date.now() - lastUsed));
  idleTimer = setTimeout(() => unloadLocalModel("idle"), wait);
}

/** Minutes of inactivity before the model is unloaded; 0 = never. */
export function configureAutoUnload(minutes) {
  const m = Number(minutes);
  unloadMs = m > 0 ? m * 60_000 : 0;
  armIdleTimer();
}

/** Keep the model loaded while a run is in progress (call with true, then false). */
export function holdLocalModel(on) {
  holds = Math.max(0, holds + (on ? 1 : -1));
  if (!on) lastUsed = Date.now();
  armIdleTimer();
}

/** Free the model's RAM and GPU memory now. Returns false if it is busy. */
export function unloadLocalModel(reason = "manual") {
  if (!worker) return true;
  if (calls.size || holds) return false;
  clearTimeout(idleTimer);
  worker.terminate();
  worker = null;
  Object.assign(localState, {
    status: "unloaded",
    device: null,
    progress: 0,
    unloadedAfterMin: reason === "idle" ? Math.round(unloadMs / 60_000) : null,
  });
  emit();
  return true;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./vlm-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.event === "progress") {
      if (data.total) localState.progress = data.loaded / data.total;
      emit();
      return;
    }
    const call = calls.get(data.id);
    if (!call) return;
    calls.delete(data.id);
    clearTimeout(call.timer);
    lastUsed = Date.now();
    data.ok ? call.resolve(data.result) : call.reject(new Error(data.error));
    armIdleTimer();
  };
  worker.onerror = (e) => {
    localState.status = "error";
    localState.error = e.message || "worker failed";
    emit();
    for (const c of calls.values()) c.reject(new Error(localState.error));
    calls.clear();
  };
  return worker;
}

function call(op, payload = {}, timeoutMs = 120_000, transfer = []) {
  const w = ensureWorker();
  const id = ++seq;
  clearTimeout(idleTimer);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      calls.delete(id);
      reject(new Error(`On-device model timed out (${op})`));
      armIdleTimer();
    }, timeoutMs);
    calls.set(id, { resolve, reject, timer });
    w.postMessage({ id, op, ...payload }, transfer);
  });
}

/** Download (first time) and initialise the model. Safe to call repeatedly. */
export async function loadLocalModel() {
  if (localState.status === "ready" && worker) return localState;
  localState.status = "loading";
  localState.error = null;
  localState.unloadedAfterMin = null;
  emit();
  try {
    // First download is ~670 MB, allow plenty of time.
    const info = await call("load", {}, 15 * 60_000);
    Object.assign(localState, { status: "ready", device: info.device, loadMs: info.loadMs, progress: 1 });
  } catch (e) {
    Object.assign(localState, { status: "error", error: e.message });
    emit();
    throw e;
  }
  lastUsed = Date.now();
  emit();
  armIdleTimer();
  return localState;
}

/** Ask the on-device model about an image (Blob). Returns { text, ms, device }. */
export async function askLocal(imageBlob, prompt, maxNewTokens = 48) {
  await loadLocalModel();
  return call("generate", { image: imageBlob, prompt, maxNewTokens }, 90_000);
}

/** True when the weights are already in the browser cache (no download needed). */
export async function isLocalModelCached() {
  try {
    const cache = await caches.open("transformers-cache");
    const keys = await cache.keys();
    return keys.some((r) => r.url.includes("FastVLM-0.5B-ONNX") && r.url.includes("decoder_model_merged"));
  } catch {
    return false;
  }
}
