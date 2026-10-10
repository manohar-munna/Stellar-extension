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
      // A little lower than the default: a missed face leaks, a false one only blurs.
      minDetectionConfidence: 0.4,
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

/**
 * Run the detector on a region of the bitmap (device px), scaled to `target` px
 * on its long side. With `inner` (the image the tile was cut from), faces cut
 * off by a tile edge inside that image are dropped — a neighbouring tile sees
 * them whole — and `minScore` filters weak tile hits.
 */
function detectIn(det, bitmap, sx, sy, sw, sh, target, { inner = null, minScore = 0 } = {}) {
  const k = target / Math.max(sw, sh);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  c.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const res = det.detect(c);
  const margin = 0.03 * Math.max(sw, sh);
  return (res.detections || [])
    .map((d) => ({
      x: sx + d.boundingBox.originX / k,
      y: sy + d.boundingBox.originY / k,
      w: d.boundingBox.width / k,
      h: d.boundingBox.height / k,
      score: d.categories?.[0]?.score ?? 0,
      // Eyes, nose, mouth (normalised to the canvas) → bitmap px.
      kps: (d.keypoints || []).slice(0, 4).map((p) => ({ x: sx + (p.x * c.width) / k, y: sy + (p.y * c.height) / k })),
    }))
    .filter((f) => {
      if (f.score < minScore) return false;
      if (!inner) return true;
      const cutLeft = sx > inner.x + 1 && f.x < sx + margin;
      const cutTop = sy > inner.y + 1 && f.y < sy + margin;
      const cutRight = sx + sw < inner.x + inner.w - 1 && f.x + f.w > sx + sw - margin;
      const cutBottom = sy + sh < inner.y + inner.h - 1 && f.y + f.h > sy + sh - margin;
      return !(cutLeft || cutTop || cutRight || cutBottom);
    });
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
  //    BlazeFace looks at a small square, so in a wide thumbnail or a group
  //    photo every face ends up tiny. Overlapping square tiles (and half-size
  //    tiles for big images) give each face enough pixels — all of them are found.
  const crops = images
    .filter((r) => r.w >= 24 && r.h >= 24 && !r.logo)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, MAX_CROPS);
  let budget = MAX_TILE_RUNS;
  for (const r of crops) {
    const sx = Math.max(0, r.x * s);
    const sy = Math.max(0, r.y * s);
    const sw = Math.min(bitmap.width - sx, r.w * s);
    const sh = Math.min(bitmap.height - sy, r.h * s);
    if (sw < 16 || sh < 16) continue;
    found.push(...detectIn(det, bitmap, sx, sy, sw, sh, 320));
    const side = Math.min(sw, sh);
    const sizes = [];
    if (Math.max(sw, sh) / side >= 1.25 || side >= 120 * s) sizes.push(side);
    if (side >= 180 * s) sizes.push(side / 2);
    if (side >= 420 * s) sizes.push(side / 3);
    for (const size of sizes) {
      for (const t of tiles(sx, sy, sw, sh, size)) {
        if (budget-- <= 0) break;
        found.push(...detectIn(det, bitmap, t.x, t.y, t.size, t.size, 256, { inner: { x: sx, y: sy, w: sw, h: sh }, minScore: 0.55 }));
      }
    }
  }

  // Not a person: logos and icons (a round logo can fool the detector), and
  // weak hits that don't have a face's layout (the Moon scored 43–48%).
  const logos = images.filter((r) => r.logo).map((r) => ({ x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s }));
  const real = found.filter((f) => !logos.some((l) => overlapShare(f, l) > 0.5) && (f.score >= SURE_SCORE || (f.score >= MIN_SCORE && faceLayout(f))));

  // Merge detections of the same face (seen whole and in tiles), keep the best.
  const kept = [];
  for (const f of real.sort((a, b) => b.score - a.score)) {
    if (kept.some((g) => iou(g, f) > 0.3 || overlapShare(f, g) > 0.6 || sameFace(f, g))) continue;
    kept.push(f);
  }

  // Back to CSS px, padded to cover hair and chin.
  const faces = kept.map((f) => ({
    category: "FACE",
    // BlazeFace boxes the eyes-to-chin area: widen it and extend upward to
    // cover forehead and hair, a little downward for the chin.
    rect: {
      x: Math.round((f.x - f.w * 0.25) / s),
      y: Math.round((f.y - f.h * 0.5) / s),
      w: Math.round((f.w * 1.5) / s),
      h: Math.round((f.h * 1.85) / s),
    },
    score: f.score,
    detail: `face (${Math.round(f.score * 100)}%)`,
  }));
  return { faces, ms: Math.round(performance.now() - t0) };
}

const MAX_TILE_RUNS = 260;
// Detections at or above SURE_SCORE count as faces; between MIN_SCORE and it,
// only when the eyes, nose and mouth sit where a face's do. Real faces score
// 0.8–0.95; round things (the Moon, globe logos) score under 0.5.
const SURE_SCORE = 0.75;
const MIN_SCORE = 0.5;

/** Eyes roughly level and apart, the nose between them and the mouth, the mouth below. */
function faceLayout(f) {
  if (f.kps.length < 4) return true;
  const [re, le, nose, mouth] = f.kps;
  const eyeY = (re.y + le.y) / 2;
  const eyeGap = Math.hypot(re.x - le.x, re.y - le.y);
  if (eyeGap < 0.25 * f.w) return false;
  if (Math.abs(re.y - le.y) > 0.6 * eyeGap) return false; // tilted past ~30°
  if (mouth.y < eyeY + 0.15 * f.h) return false;
  if (nose.y < eyeY - 0.05 * f.h || nose.y > mouth.y + 0.05 * f.h) return false;
  return true;
}

/** Overlapping (50%) square tiles of `size` covering a rect. */
function tiles(x, y, w, h, size) {
  const out = [];
  const step = size / 2;
  const xs = [];
  const ys = [];
  for (let tx = x; tx < x + w - step * 0.5; tx += step) xs.push(Math.min(tx, x + w - size));
  for (let ty = y; ty < y + h - step * 0.5; ty += step) ys.push(Math.min(ty, y + h - size));
  for (const ty of [...new Set(ys.map(Math.round))]) for (const tx of [...new Set(xs.map(Math.round))]) out.push({ x: Math.max(x, tx), y: Math.max(y, ty), size });
  return out;
}

/** Two boxes whose centres are within ~half a face of each other are one face. */
function sameFace(a, b) {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2);
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  return Math.hypot(dx, dy) < 0.6 * Math.max(a.w, a.h, b.w, b.h);
}

/** Share of a's area that lies inside b. */
function overlapShare(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / (a.w * a.h || 1);
}

/** Warm the WASM runtime and model so the first frame isn't slower. */
export function preloadFaceDetector() {
  return getDetector().then(() => true, () => false);
}
