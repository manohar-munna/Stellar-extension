// Canvas rendering for the Detect / Redact stages. All drawing happens in the
// side panel (on-device); only the sanitized JPEG is ever sent anywhere.

import { CATEGORY_COLORS } from "./privacy.js";

const KIND_COLORS = {
  BUTTON: "#22d3ee",
  LINK: "#60a5fa",
  INPUT: "#4ade80",
  SELECT: "#facc15",
  CHECKBOX: "#f472b6",
  RADIO: "#f472b6",
  TAB: "#c084fc",
  OPTION: "#c084fc",
};

export async function loadBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

function makeCanvas(bitmap) {
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  return { c, ctx };
}

function chip(ctx, text, x, y, color, s, { fg = "#06060a", maxX } = {}) {
  ctx.font = `600 ${Math.round(10 * s)}px ui-monospace, Consolas, monospace`;
  const padX = 3 * s;
  const h = 14 * s;
  const w = ctx.measureText(text).width + padX * 2;
  let cx = x;
  if (maxX && cx + w > maxX) cx = maxX - w;
  const cy = Math.max(0, y - h);
  ctx.fillStyle = color;
  ctx.fillRect(cx, cy, w, h);
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx + padX, cy + h / 2 + 0.5 * s);
}

function scaled(rect, s, pad = 0) {
  return {
    x: (rect.x - pad) * s,
    y: (rect.y - pad) * s,
    w: (rect.w + pad * 2) * s,
    h: (rect.h + pad * 2) * s,
  };
}

/** Raw capture with detection outlines — local preview only. */
export function renderDetection(bitmap, viewport, regions) {
  const s = bitmap.width / viewport.w;
  const { c, ctx } = makeCanvas(bitmap);
  for (const r of regions) {
    const b = scaled(r.rect, s, 2);
    const color = CATEGORY_COLORS[r.category] || "#f43f5e";
    ctx.save();
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = color;
    ctx.setLineDash([5 * s, 3 * s]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = color + "26";
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.restore();
    chip(ctx, `${r.tag} · ${r.source}`, b.x, b.y, color, s, { maxX: c.width });
  }
  return c;
}

// Redaction policy from PS 26171: blur faces, black out passwords, mask PII.
const BLUR = new Set(["FACE", "SIGNATURE"]);
const BLACK = new Set(["PASSWORD", "API_KEY", "OTP", "CVV", "CARD", "ACCOUNT", "GOV_ID"]);

export function treatmentOf(category) {
  return BLUR.has(category) ? "blur" : BLACK.has(category) ? "black" : "mask";
}

function drawTag(ctx, label, b, s, { small = false } = {}) {
  let size = small ? 10 * s : Math.min(b.h * 0.62, 13 * s);
  ctx.font = `700 ${size}px ui-monospace, Consolas, monospace`;
  const w = ctx.measureText(label).width;
  if (!small && w > b.w * 0.94) {
    size = Math.max(7 * s, (size * b.w * 0.94) / w);
    ctx.font = `700 ${size}px ui-monospace, Consolas, monospace`;
  }
  if (small) {
    // A chip in the corner, so the blurred area stays recognisable as a photo.
    const pad = 3 * s;
    const cw = ctx.measureText(label).width + pad * 2;
    ctx.fillStyle = "rgba(11,11,18,0.85)";
    ctx.fillRect(b.x, b.y, Math.min(cw, b.w), size + pad * 2);
    ctx.fillStyle = "#f5f6f8";
    ctx.textBaseline = "top";
    ctx.fillText(label, b.x + pad, b.y + pad, b.w - pad * 2);
    return;
  }
  ctx.fillStyle = "#f5f6f8";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2, b.w * 0.96);
  ctx.textAlign = "start";
}

/** Pixelate then blur a region in place: identity is gone, "there is a photo here" stays. */
function blurRegion(ctx, c, b, s) {
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  const w = Math.min(c.width - x, Math.ceil(b.w));
  const h = Math.min(c.height - y, Math.ceil(b.h));
  if (w < 2 || h < 2) return;
  const radius = Math.max(4, Math.round(Math.min(w, h) / 6));
  const pad = radius * 2;
  // Sample a little beyond the box: a CSS blur fades to transparent at its
  // edges, which would let the real face show through around the rim.
  const ex = Math.max(0, x - pad);
  const ey = Math.max(0, y - pad);
  const ew = Math.min(c.width, x + w + pad) - ex;
  const eh = Math.min(c.height, y + h + pad) - ey;
  // Four blocks across the face, then smoothed: eyes, nose and mouth are gone
  // at any size, while it still reads as a photo of a person.
  const cells = 4;
  const per = Math.min(w, h) / cells;
  const tiny = document.createElement("canvas");
  tiny.width = Math.max(1, Math.round(ew / per));
  tiny.height = Math.max(1, Math.round(eh / per));
  const tctx = tiny.getContext("2d");
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(c, ex, ey, ew, eh, 0, 0, tiny.width, tiny.height);
  // The average colour sits underneath, so nothing original survives anywhere in the box.
  const avg = document.createElement("canvas");
  avg.width = avg.height = 1;
  avg.getContext("2d").drawImage(tiny, 0, 0, 1, 1);
  const [r, g, bl] = avg.getContext("2d").getImageData(0, 0, 1, 1).data;
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.22);
  else ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = `rgb(${r}, ${g}, ${bl})`;
  ctx.fillRect(x, y, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, ex, ey, ew, eh);
  ctx.filter = "none";
  ctx.restore();
}

/** Sanitized view: per-category redaction with semantic tags + interactive element marks. */
export function renderSanitized(bitmap, viewport, regions, elements) {
  const s = bitmap.width / viewport.w;
  const { c, ctx } = makeCanvas(bitmap);

  // Element marks (Set-of-Marks) so the model can say "click [BUTTON_03]".
  for (const e of elements) {
    const b = scaled(e.rect, s);
    const color = KIND_COLORS[e.kind] || "#22d3ee";
    ctx.lineWidth = 1.5 * s;
    ctx.strokeStyle = color;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    chip(ctx, e.tag, b.x, b.y, color, s, { maxX: c.width });
  }

  // Redactions on top: blurred faces first, then solid masks (which win on overlap).
  const ordered = [...regions].sort((a, b) => (treatmentOf(a.category) === "blur" ? 0 : 1) - (treatmentOf(b.category) === "blur" ? 0 : 1));
  for (const r of ordered) {
    const b = scaled(r.rect, s, 2);
    const color = CATEGORY_COLORS[r.category] || "#f43f5e";
    const how = treatmentOf(r.category);
    if (how === "blur") {
      blurRegion(ctx, c, b, s);
      drawTag(ctx, `[${r.tag}]`, b, s, { small: true });
      continue;
    }
    ctx.fillStyle = how === "black" ? "#050507" : "#1c2033";
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = color;
    ctx.fillRect(b.x, b.y, Math.max(2 * s, 3), b.h);
    drawTag(ctx, `[${r.tag}]`, b, s);
  }
  return c;
}

/** Downscale + JPEG-encode a canvas for transmission or display. */
export function encodeJpeg(canvas, maxW = 1280, quality = 0.85) {
  let out = canvas;
  if (canvas.width > maxW) {
    out = document.createElement("canvas");
    out.width = maxW;
    out.height = Math.round((canvas.height * maxW) / canvas.width);
    const ctx = out.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
  }
  const dataUrl = out.toDataURL("image/jpeg", quality);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { dataUrl, base64, bytes: Math.round((base64.length * 3) / 4), w: out.width, h: out.height };
}
