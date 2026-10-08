// Panel-side client for the on-device VLM worker.

export const LOCAL_MODEL = { id: "onnx-community/FastVLM-0.5B-ONNX", name: "FastVLM-0.5B", approxMB: 670 };

let worker = null;
let seq = 0;
const calls = new Map();
const listeners = new Set();
export const localState = { status: "idle", device: null, loadMs: null, error: null, progress: 0 };

function emit() {
  for (const fn of listeners) fn({ ...localState });
}

export function onLocalState(fn) {
  listeners.add(fn);
  fn({ ...localState });
  return () => listeners.delete(fn);
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
    data.ok ? call.resolve(data.result) : call.reject(new Error(data.error));
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      calls.delete(id);
      reject(new Error(`On-device model timed out (${op})`));
    }, timeoutMs);
    calls.set(id, { resolve, reject, timer });
    w.postMessage({ id, op, ...payload }, transfer);
  });
}

/** Download (first time) and initialise the model. Safe to call repeatedly. */
export async function loadLocalModel() {
  if (localState.status === "ready") return localState;
  localState.status = "loading";
  localState.error = null;
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
  emit();
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
