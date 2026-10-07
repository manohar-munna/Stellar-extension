// Minimal Gemini REST client (generativelanguage.googleapis.com, v1beta)
// with Stellar-style key rotation and model fallback.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Tried in order after the configured model when it is overloaded (503/429).
export const FALLBACK_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.7-flash",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
];

const ATTEMPT_TIMEOUT_MS = 35_000;
// When every key/model is only busy (503/429/timeout), wait and go round again.
const BACKOFF_MS = [4_000, 10_000];

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Tolerate ```json fences or stray prose around the object.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new GeminiError("Model did not return valid JSON");
  }
}

// ------------------------------------------------------------ key rotation
// Settings may hold several keys (comma / newline separated). Like Stellar's
// GlobalKeyManager, a key that is rejected is parked for an hour; a key that is
// rate-limited or hits an overloaded model is parked for that model only.

const parked = new Map(); // "key" or "key|model" -> epoch ms until which it is skipped
let cursor = 0;

export function parseKeys(raw) {
  return [
    ...new Set(
      String(raw || "")
        .split(/[\s,]+/)
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ];
}

/** Google echoes API keys in some error messages; never let them reach the UI or logs. */
export function scrubKeys(message, keys = []) {
  let s = String(message || "");
  keys.forEach((k, i) => (s = s.split(k).join(`<key #${i + 1}>`)));
  return s.replace(/AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_.-]{20,}/g, "<key>");
}

function isParked(key, model, now) {
  return (parked.get(key) || 0) > now || (parked.get(`${key}|${model}`) || 0) > now;
}

function orderedKeys(keys, model) {
  const now = Date.now();
  const rotated = keys.map((_, i) => keys[(cursor + i) % keys.length]);
  const ready = rotated.filter((k) => !isParked(k, model, now));
  // Everything parked: still try the keys that weren't rejected outright.
  return ready.length ? ready : rotated.filter((k) => (parked.get(k) || 0) <= now);
}

// How long to skip a key for one model. Quota errors carry Google's RetryInfo
// (e.g. "retryDelay": "41s"; daily quotas give much longer), which we honour.
function parkMs(status, data) {
  const info = (data?.error?.details || []).find((d) => String(d["@type"] || "").endsWith("RetryInfo"));
  const secs = parseFloat(info?.retryDelay);
  if (secs > 0) return Math.min(Math.max(secs * 1000, 20_000), 6 * 3_600_000);
  if (status === 429) return /quota/i.test(data?.error?.message || "") ? 10 * 60_000 : 60_000;
  return 20_000;
}

// What a failed attempt means: "key" (key is bad), "busy" (try another key),
// "model" (model unavailable; next model) or "fatal" (the request itself is wrong).
function classify(status, message) {
  if (status === 401 || status === 403) return "key";
  if (status === 400 && /api key|API_KEY/i.test(message)) return "key";
  if (status === 429 || status >= 500 || status === 0) return "busy";
  if (status === 404) return "model";
  return "fatal";
}

/**
 * Calls generateContent and parses a JSON response.
 * `image` is { mimeType, base64 }.
 * `onRetry(ms, lastError)` is called before each backoff wait.
 * Returns { json, text, usage, latencyMs, model, keyIndex, keyCount, attempts }.
 */
export async function generateJson({ apiKey, model, system, prompt, image, schema, temperature = 0.2, signal, onRetry }) {
  const keys = parseKeys(apiKey);
  if (!keys.length) throw new GeminiError("No Gemini API key set — open Settings.");
  const parts = [];
  if (image) parts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
  parts.push({ text: prompt });

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature,
      responseMimeType: "application/json",
      ...(schema ? { responseSchema: schema } : {}),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  // Gemini 3 models think by default; UI perception needs little of it and
  // low thinking roughly halves latency. Models that reject it get it removed.
  const noThinking = new Set();
  const payloadFor = (m) =>
    JSON.stringify(
      /^gemini-3/.test(m) && !noThinking.has(m) ? { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { thinkingLevel: "low" } } } : body,
    );

  const models = [model, ...FALLBACK_MODELS.filter((m) => m !== model)];
  const errors = [];
  let attempts = 0;

  for (let round = 0; round <= BACKOFF_MS.length; round++) {
    if (round > 0) {
      // Overload is transient: forget short per-model parks (not quota parks) and go again.
      for (const [k, until] of [...parked]) if (k.includes("|") && until - Date.now() < 120_000) parked.delete(k);
      const wait = BACKOFF_MS[round - 1];
      onRetry?.(wait, errors[errors.length - 1]);
      await sleep(wait, signal);
    }
    for (const m of models) {
      for (const key of orderedKeys(keys, m)) {
        attempts++;
        const t0 = performance.now();
        let res;
        let data = {};
        try {
          res = await fetch(`${API_BASE}/models/${encodeURIComponent(m)}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: payloadFor(m),
            signal: AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)].filter(Boolean)),
          });
          data = await res.json().catch(() => ({}));
        } catch (e) {
          if (signal?.aborted) throw e;
          res = { ok: false, status: 0 };
          data = { error: { message: e.name === "TimeoutError" ? `timed out after ${ATTEMPT_TIMEOUT_MS / 1000}s` : e.message } };
        }
        const latencyMs = Math.round(performance.now() - t0);

        if (!res.ok) {
          const message = scrubKeys(data?.error?.message || `HTTP ${res.status}`, keys);
          const kind = classify(res.status, message);
          errors.push(`${m} / key #${keys.indexOf(key) + 1}: ${res.status || "network"} ${message}`);
          if (kind === "fatal" && /thinking/i.test(message) && !noThinking.has(m)) {
            noThinking.add(m);
            continue; // retry this model without thinkingConfig on the next key
          }
          if (kind === "fatal") throw new GeminiError(message, res.status);
          if (kind === "key") parked.set(key, Date.now() + 3_600_000);
          else parked.set(`${key}|${m}`, Date.now() + parkMs(res.status, data));
          if (kind === "model") break;
          continue;
        }

        cursor = (keys.indexOf(key) + 1) % keys.length; // spread load across keys
        const cand = data.candidates?.[0];
        if (!cand) {
          const reason = data.promptFeedback?.blockReason;
          throw new GeminiError(reason ? `Prompt blocked: ${reason}` : "Empty response from Gemini");
        }
        const text = (cand.content?.parts || [])
          .filter((p) => typeof p.text === "string" && !p.thought)
          .map((p) => p.text)
          .join("");
        if (!text) throw new GeminiError(`No text in response (finishReason: ${cand.finishReason || "unknown"})`);
        return {
          json: extractJson(text),
          text,
          usage: data.usageMetadata || null,
          latencyMs,
          model: m,
          keyIndex: keys.indexOf(key) + 1,
          keyCount: keys.length,
          attempts,
        };
      }
    }
    // No key left that isn't rejected outright: retrying cannot help.
    if (keys.every((k) => (parked.get(k) || 0) > Date.now())) break;
  }
  const distinct = [...new Set(errors.map((e) => e.replace(/^[^:]*: /, "")))].slice(-3);
  throw new GeminiError(`All keys/models failed after ${attempts} attempts — ${distinct.join(" | ") || "no usable key"}`);
}

/** Lists models available to the first working key; also reports per-key health. */
export async function listModels(rawKeys) {
  const keys = parseKeys(rawKeys);
  let models = null;
  let working = 0;
  let lastErr;
  for (const key of keys) {
    try {
      const m = await listModelsForKey(key);
      working++;
      if (!models) models = m;
    } catch (e) {
      lastErr = new GeminiError(scrubKeys(e.message, keys), e.status);
      parked.set(key, Date.now() + 3_600_000);
    }
  }
  if (!models) throw lastErr || new GeminiError("No key set");
  return { models, working, total: keys.length };
}

async function listModelsForKey(apiKey) {
  const out = [];
  let pageToken = "";
  do {
    const url = `${API_BASE}/models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new GeminiError(data?.error?.message || `HTTP ${res.status}`, res.status);
    for (const m of data.models || []) {
      if ((m.supportedGenerationMethods || []).includes("generateContent")) {
        out.push(m.name.replace(/^models\//, ""));
      }
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return out;
}
