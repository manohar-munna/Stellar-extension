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

/** Sanitized view: PII masked with semantic tags + interactive element marks. */
export function renderSanitized(bitmap, viewport, regions, elements, { style = "solid" } = {}) {
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

  // Redactions on top.
  for (const r of regions) {
    const b = scaled(r.rect, s, 2);
    const color = CATEGORY_COLORS[r.category] || "#f43f5e";
    ctx.save();
    if (style === "blur") {
      ctx.beginPath();
      ctx.rect(b.x, b.y, b.w, b.h);
      ctx.clip();
      ctx.filter = `blur(${Math.round(14 * s)}px)`;
      ctx.drawImage(c, b.x - 40 * s, b.y - 40 * s, b.w + 80 * s, b.h + 80 * s, b.x - 40 * s, b.y - 40 * s, b.w + 80 * s, b.h + 80 * s);
      ctx.filter = "none";
      ctx.fillStyle = "rgba(11,11,18,0.55)";
      ctx.fillRect(b.x, b.y, b.w, b.h);
    } else {
      ctx.fillStyle = "#0b0b12";
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    ctx.fillStyle = color;
    ctx.fillRect(b.x, b.y, Math.max(2 * s, 3), b.h);
    ctx.restore();

    const label = `[${r.tag}]`;
    let size = Math.min(b.h * 0.62, 13 * s);
    ctx.font = `700 ${size}px ui-monospace, Consolas, monospace`;
    const w = ctx.measureText(label).width;
    if (w > b.w * 0.94) {
      size = Math.max(7 * s, (size * b.w * 0.94) / w);
      ctx.font = `700 ${size}px ui-monospace, Consolas, monospace`;
    }
    ctx.fillStyle = "#f5f6f8";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2, b.w * 0.96);
    ctx.textAlign = "start";
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
