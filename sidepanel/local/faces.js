// On-device face detection (MediaPipe BlazeFace, ~230 KB model, WebAssembly).
// Nothing leaves the device: the WASM runtime and model ship with the
// extension. Faces are searched for in the whole frame and, zoomed in, inside
// every visible image on the page so small avatars are found too.

import { FaceDetector } from "../../vendor/mediapipe/vision_bundle.mjs";

const MAX_CROPS = 30;
let detectorP = null;

// MediaPipe's WASM runtime prints its start-up notes (GL context, XNNPACK
// delegate, feedback tensors) through console.error/warn, so Chrome lists them
// as extension "errors". They are informational; only those exact notes are
// dropped — anything else still reaches the console.
const MEDIAPIPE_NOISE = /gl_context\.cc|OpenGL error checking is disabled|XNNPACK delegate|inference_feedback_manager|Graph successfully started running/;
for (const level of ["log", "info", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === "string" && MEDIAPIPE_NOISE.test(args[0])) return;
    original(...args);
  };
}

function getDetector() {
  detectorP ??= FaceDetector.createFromOptions(
    {
      wasmLoaderPath: chrome.runtime.getURL("vendor/mediapipe/vision_wasm_internal.js"),
      wasmBinaryPath: chrome.runtime.getURL("vendor/mediapipe/vision_wasm_internal.wasm"),
    },
    {
      baseOptions: { modelAssetPath: chrome.runtime.getURL("vendor/mediapipe/blaze_face_short_range.tflite"), delegate: "CPU" },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.5,
    }
  ).catch((e) => {
    detectorP = null;
    throw e;
  });
  return detectorP;
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/** Run the detector on a region of the bitmap (device px), scaled to `target` px on its long side. */
function detectIn(det, bitmap, sx, sy, sw, sh, target) {
  const k = target / Math.max(sw, sh);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  c.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const res = det.detect(c);
  return (res.detections || []).map((d) => ({
    x: sx + d.boundingBox.originX / k,
    y: sy + d.boundingBox.originY / k,
    w: d.boundingBox.width / k,
    h: d.boundingBox.height / k,
    score: d.categories?.[0]?.score ?? 0,
  }));
}

/**
 * Find faces in the captured frame.
 * @param bitmap   ImageBitmap of the screenshot (device pixels)
 * @param viewport { w, h } in CSS pixels
 * @param images   [{ x, y, w, h }] visible image rects in CSS pixels (from the page scan)
 * @returns { faces: [{ category:"FACE", rect, score, detail }], ms }
 */
export async function detectFaces(bitmap, viewport, images = []) {
  const t0 = performance.now();
  const det = await getDetector();
  const s = bitmap.width / viewport.w;
  const found = [];

  // 1. Whole frame (faces in canvases, backgrounds, video).
  found.push(...detectIn(det, bitmap, 0, 0, bitmap.width, bitmap.height, 1280));

  // 2. Each visible image, zoomed so small avatars are large enough to detect.
  const crops = images
    .filter((r) => r.w >= 24 && r.h >= 24)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, MAX_CROPS);
  for (const r of crops) {
    const sx = Math.max(0, r.x * s);
    const sy = Math.max(0, r.y * s);
    const sw = Math.min(bitmap.width - sx, r.w * s);
    const sh = Math.min(bitmap.height - sy, r.h * s);
    if (sw < 16 || sh < 16) continue;
    found.push(...detectIn(det, bitmap, sx, sy, sw, sh, 320));
  }

  // Back to CSS px, padded to cover hair and chin, de-duplicated.
  const faces = [];
  for (const f of found.sort((a, b) => b.score - a.score)) {
    // BlazeFace boxes the eyes-to-chin area: widen it and extend upward to
    // cover forehead and hair, a little downward for the chin.
    const rect = {
      x: Math.round((f.x - f.w * 0.22) / s),
      y: Math.round((f.y - f.h * 0.5) / s),
      w: Math.round((f.w * 1.44) / s),
      h: Math.round((f.h * 1.65) / s),
    };
    if (faces.some((g) => iou(g.rect, rect) > 0.35)) continue;
    faces.push({ category: "FACE", rect, score: f.score, detail: `face (${Math.round(f.score * 100)}%)` });
  }
  return { faces, ms: Math.round(performance.now() - t0) };
}

/** Warm the WASM runtime and model so the first frame isn't slower. */
export function preloadFaceDetector() {
  return getDetector().then(() => true, () => false);
}
