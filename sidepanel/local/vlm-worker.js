// On-device vision-language model (FastVLM-0.5B, ONNX) running in a module
// worker so inference never blocks the panel UI. WebGPU when available,
// WebAssembly otherwise. Weights are fetched once from Hugging Face and kept
// in the browser's Cache Storage by Transformers.js.

import { AutoProcessor, AutoModelForImageTextToText, RawImage, env } from "../../vendor/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL("../../vendor/ort/", import.meta.url).href;
env.backends.onnx.wasm.proxy = false;
// Transformers.js asks WebGPU for a "high-performance" adapter; Chrome ignores
// that on Windows and logs a warning on every load. Let Chrome pick (same GPU).
if (env.backends.onnx.webgpu) env.backends.onnx.webgpu.powerPreference = undefined;

export const MODEL_ID = "onnx-community/FastVLM-0.5B-ONNX";

// Benchmarked on WebGPU: same accuracy as the model card's settings at ~670 MB
// instead of ~1.1 GB (fp16 vision tower, 4-bit fp16 decoder, 8-bit embeddings).
const DTYPE_WEBGPU = { embed_tokens: "uint8", vision_encoder: "fp16", decoder_model_merged: "q4f16" };
const DTYPE_WASM = { embed_tokens: "uint8", vision_encoder: "uint8", decoder_model_merged: "q4" };

let processor = null;
let model = null;
let device = null;
let loading = null;

async function pickDevice() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) return { device: "webgpu", f16: adapter.features.has("shader-f16") };
  } catch {
    /* no WebGPU */
  }
  return { device: "wasm", f16: false };
}

async function load(id) {
  if (model) return { device, cached: true };
  loading ??= (async () => {
    const t0 = performance.now();
    const pick = await pickDevice();
    device = pick.device;
    const dtype = device === "webgpu" && pick.f16 ? DTYPE_WEBGPU : device === "webgpu" ? { ...DTYPE_WEBGPU, vision_encoder: "fp32", decoder_model_merged: "q4" } : DTYPE_WASM;
    const files = {};
    const progress_callback = (p) => {
      if (p.file && p.total) files[p.file] = { loaded: p.loaded ?? p.total, total: p.total };
      if (p.status === "progress" || p.status === "done") {
        const all = Object.values(files);
        const loaded = all.reduce((a, f) => a + f.loaded, 0);
        const total = all.reduce((a, f) => a + f.total, 0);
        postMessage({ id, event: "progress", loaded, total, file: p.file });
      }
    };
    processor = await AutoProcessor.from_pretrained(MODEL_ID, { progress_callback });
    model = await AutoModelForImageTextToText.from_pretrained(MODEL_ID, { dtype, device, progress_callback });
    // Warm-up compiles the GPU shaders so the first real call is fast.
    const blank = new RawImage(new Uint8ClampedArray(64 * 64 * 3).fill(255), 64, 64, 3);
    await runGenerate(blank, "Describe the image.", 2);
    const bytes = Object.values(files).reduce((a, f) => a + f.total, 0);
    return { device, dtype, loadMs: Math.round(performance.now() - t0), bytes };
  })();
  try {
    return await loading;
  } catch (e) {
    loading = null;
    throw e;
  }
}

async function runGenerate(image, text, maxNewTokens) {
  const messages = [{ role: "user", content: `<image>${text}` }];
  const prompt = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(image, prompt, { add_special_tokens: false });
  const ids = await model.generate({ ...inputs, max_new_tokens: maxNewTokens, do_sample: false, repetition_penalty: 1.05 });
  const gen = ids.slice(null, [inputs.input_ids.dims.at(-1), null]);
  return processor.batch_decode(gen, { skip_special_tokens: true })[0].trim();
}

self.onmessage = async ({ data }) => {
  const { id, op } = data;
  try {
    if (op === "load") {
      const info = await load(id);
      postMessage({ id, ok: true, result: info });
    } else if (op === "generate") {
      await load(id);
      const image = await RawImage.fromBlob(data.image);
      const t0 = performance.now();
      const text = await runGenerate(image, data.prompt, data.maxNewTokens || 64);
      postMessage({ id, ok: true, result: { text, ms: Math.round(performance.now() - t0), device } });
    } else if (op === "status") {
      postMessage({ id, ok: true, result: { loaded: !!model, device } });
    }
  } catch (e) {
    postMessage({ id, ok: false, error: String(e?.message || e) });
  }
};
