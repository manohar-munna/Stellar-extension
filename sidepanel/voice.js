// Voice: speak a task in any language, hear the result back.
//
// - Listening uses Chrome's Web Speech recognition (live text as you speak).
//   It must be told the language up front and writes whatever it hears in
//   that language (Telugu comes out as Hindi if it listened in Hindi). So
//   "Auto" shows the browser text only as a live preview, then has Gemini
//   identify the spoken language from the recorded clip and transcribe it,
//   and remembers that language so the next preview is right too.
// - The language of any text is identified on-device (Chrome's built-in
//   LanguageDetector when present, otherwise by script).
// - Replies are read aloud with the browser's speech synthesis in that language.
//
// Chrome's recognizer sends the audio to Google's speech service; page
// content is never part of it.

import { generateJson } from "./gemini.js";

export const VOICE_LANGS = [
  ["auto", "Auto"],
  ["en-IN", "English (India)"],
  ["hi-IN", "हिन्दी"],
  ["ta-IN", "தமிழ்"],
  ["te-IN", "తెలుగు"],
  ["kn-IN", "ಕನ್ನಡ"],
  ["ml-IN", "മലയാളം"],
  ["mr-IN", "मराठी"],
  ["bn-IN", "বাংলা"],
  ["gu-IN", "ગુજરાતી"],
  ["pa-IN", "ਪੰਜਾਬੀ"],
  ["or-IN", "ଓଡ଼ିଆ"],
  ["ur-IN", "اردو"],
  ["en-US", "English (US)"],
  ["es-ES", "Español"],
  ["fr-FR", "Français"],
  ["de-DE", "Deutsch"],
  ["pt-BR", "Português"],
  ["it-IT", "Italiano"],
  ["ru-RU", "Русский"],
  ["ar-SA", "العربية"],
  ["ja-JP", "日本語"],
  ["ko-KR", "한국어"],
  ["zh-CN", "中文"],
];

const NAMES = {
  en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam", mr: "Marathi", bn: "Bengali",
  gu: "Gujarati", pa: "Punjabi", or: "Odia", ur: "Urdu", es: "Spanish", fr: "French", de: "German", pt: "Portuguese",
  it: "Italian", ru: "Russian", ar: "Arabic", ja: "Japanese", ko: "Korean", zh: "Chinese",
};
const DEFAULT_REGION = { en: "en-IN", hi: "hi-IN", ta: "ta-IN", te: "te-IN", kn: "kn-IN", ml: "ml-IN", mr: "mr-IN", bn: "bn-IN", gu: "gu-IN", pa: "pa-IN", or: "or-IN", ur: "ur-IN", es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-BR", it: "it-IT", ru: "ru-RU", ar: "ar-SA", ja: "ja-JP", ko: "ko-KR", zh: "zh-CN" };

export const baseOf = (lang) => String(lang || "en").toLowerCase().split(/[-_]/)[0];
export const languageName = (lang) => NAMES[baseOf(lang)] || lang;
export const fullTag = (lang) => (String(lang).includes("-") ? lang : DEFAULT_REGION[baseOf(lang)] || lang);

export const voiceSupported = () => !!(self.SpeechRecognition || self.webkitSpeechRecognition);

// ------------------------------------------------------------ identify text

const SCRIPTS = [
  [/[஀-௿]/, "ta"], [/[ఀ-౿]/, "te"], [/[ಀ-೿]/, "kn"], [/[ഀ-ൿ]/, "ml"],
  [/[ঀ-৿]/, "bn"], [/[਀-੿]/, "pa"], [/[઀-૿]/, "gu"], [/[଀-୿]/, "or"],
  [/[ऀ-ॿ]/, "hi"], [/[぀-ヿ]/, "ja"], [/[가-힯]/, "ko"], [/[一-鿿]/, "zh"],
  [/[؀-ۿ]/, "ar"], [/[Ѐ-ӿ]/, "ru"],
];

let detectorP = null;
async function builtInDetector() {
  if (!self.LanguageDetector) return null;
  detectorP ||= (async () => {
    try {
      if ((await self.LanguageDetector.availability()) !== "available") return null;
      return await self.LanguageDetector.create();
    } catch {
      return null;
    }
  })();
  return detectorP;
}

/** Language of a piece of text, on-device. `hint` breaks ties (e.g. Hindi vs Marathi, Arabic vs Urdu). */
export async function identifyLanguage(text, hint = "") {
  const t = String(text || "").trim();
  if (!t) return null;
  const det = await builtInDetector();
  if (det) {
    try {
      const [top] = await det.detect(t);
      if (top && top.confidence > 0.6 && top.detectedLanguage !== "und") return baseOf(top.detectedLanguage);
    } catch {
      /* fall back to script */
    }
  }
  for (const [re, lang] of SCRIPTS) {
    if (!re.test(t)) continue;
    if (lang === "hi" && baseOf(hint) === "mr") return "mr";
    if (lang === "ar" && baseOf(hint) === "ur") return "ur";
    return lang;
  }
  // Latin script: trust the hint when it is a Latin-script language, else English.
  return ["en", "es", "fr", "de", "pt", "it"].includes(baseOf(hint)) ? baseOf(hint) : "en";
}

// ------------------------------------------------------------ speak

let voicesP = null;
function voices() {
  voicesP ||= new Promise((resolve) => {
    const v = speechSynthesis.getVoices();
    if (v.length) return resolve(v);
    speechSynthesis.addEventListener("voiceschanged", () => resolve(speechSynthesis.getVoices()), { once: true });
    setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
  });
  return voicesP;
}

/** Read text aloud in its own language (falls back to `lang`). */
export async function speak(text, lang) {
  if (!self.speechSynthesis || !text) return;
  const clean = String(text).replace(/\[([A-Z][A-Z0-9_]*)\]/g, (m, t) => t.replace(/_\d+$/, "").replace(/^VAULT_/, "").replace(/_/g, " ").toLowerCase()).slice(0, 600);
  const base = (await identifyLanguage(clean, lang)) || baseOf(lang);
  const tag = baseOf(lang) === base ? fullTag(lang) : fullTag(base);
  const all = await voices();
  const voice = all.find((v) => v.lang.toLowerCase() === tag.toLowerCase()) || all.find((v) => baseOf(v.lang) === base);
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = tag;
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

export const stopSpeaking = () => self.speechSynthesis?.cancel();

// ------------------------------------------------------------ listen

/**
 * Records the microphone and returns 16 kHz mono WAV (for the Gemini language
 * check). MediaRecorder is used because a live AudioContext created outside a
 * click starts suspended (autoplay policy) and would record silence; the
 * OfflineAudioContext that decodes and resamples has no such restriction.
 */
export class WavRecorder {
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    this.parts = [];
    this.mr = new MediaRecorder(this.stream);
    this.mr.ondataavailable = (e) => e.data.size && this.parts.push(e.data);
    this.mr.start(250);
  }

  async stop() {
    if (!this.mr) return null;
    if (this.mr.state !== "inactive") {
      await new Promise((resolve) => {
        this.mr.onstop = resolve;
        this.mr.stop();
      });
    }
    this.stream.getTracks().forEach((t) => t.stop());
    const recorded = new Blob(this.parts, { type: this.mr.mimeType || "audio/webm" });
    if (recorded.size < 2000) return null;
    let audio;
    try {
      audio = await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(await recorded.arrayBuffer());
    } catch {
      return null;
    }
    const pcm = audio.getChannelData(0).subarray(0, 16000 * 30); // 30 s is plenty for a command
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-1, Math.min(1, pcm[i])) * 0x7fff;
    const buf = new ArrayBuffer(44 + out.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((ch, k) => v.setUint8(o + k, ch.charCodeAt(0)));
    str(0, "RIFF"); v.setUint32(4, 36 + out.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
    v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, out.length * 2, true);
    new Int16Array(buf, 44).set(out);
    return new Blob([buf], { type: "audio/wav" });
  }
}

const ID_SCHEMA = {
  type: "OBJECT",
  properties: { language_code: { type: "STRING" }, language_name: { type: "STRING" }, transcript: { type: "STRING" } },
  required: ["language_code", "transcript"],
};

/**
 * Gemini identifies the spoken language and transcribes the clip. `heard` is
 * what the browser recognizer produced — it is forced into the language it
 * was set to, so it can be confidently wrong (Telugu written out as Hindi).
 */
export async function identifySpeech(wav, settings, heard = null) {
  const bytes = new Uint8Array(await wav.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const { json } = await generateJson({
    apiKey: settings.apiKey,
    model: settings.detectModel || settings.reasonModel,
    prompt:
      "This is a short voice command for a browser assistant. Identify the language the speaker is actually speaking, from the audio, and transcribe it exactly (do not translate).\n" +
      "- Indian speakers often mix English words (app and site names, 'open', 'search', 'send') into their own language. Decide the language from its own words, verb endings and particles — e.g. 'Wikipedia open chei' / 'open cheyyi' is Telugu, 'open karo' is Hindi, 'open pannu' is Tamil, 'open maadi' is Kannada, 'open cheyyu' is Malayalam, 'open kara' is Marathi.\n" +
      "- Write the transcript in that language's native script, but keep English words and names in English (Latin letters), as people type them.\n" +
      (heard?.text ? `- A browser recognizer set to ${languageName(heard.lang)} heard: "${heard.text}". It is forced into that language and is often wrong — trust the audio.\n` : "") +
      "language_code must be a BCP-47 tag with region, e.g. te-IN, hi-IN, ta-IN, en-IN, es-ES.",
    image: { mimeType: "audio/wav", base64: btoa(bin) },
    schema: ID_SCHEMA,
    temperature: 0,
  });
  return json;
}

/**
 * One listening session. Callbacks: onInterim(text), onDone({ text, lang, via }), onError(code, message).
 * `lang` is a BCP-47 tag or "auto".
 */
export class Listener {
  constructor({ lang, settings, lastLang, onInterim, onDone, onError, onStatus }) {
    Object.assign(this, { lang, settings, lastLang, onInterim, onDone, onError, onStatus });
    this.auto = lang === "auto";
    this.listenLang = this.auto ? fullTag(lastLang || navigator.language || "en-IN") : lang;
  }

  async start() {
    const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
    if (!SR) return this.onError("unsupported", "This browser has no speech recognition.");
    // Recording in parallel lets Auto ask Gemini when the recognizer was unsure.
    if (this.auto && this.settings.apiKey) {
      this.rec = new WavRecorder();
      try {
        await this.rec.start();
      } catch (e) {
        this.rec = null;
        if (e?.name === "NotAllowedError") return this.onError("not-allowed", "Microphone permission is needed.");
        this.skipWhy = `couldn't record the clip (${e?.message || e})`;
      }
    }
    const r = (this.r = new SR());
    r.lang = this.listenLang;
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    this.finalText = "";
    this.confidence = 0;
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          this.finalText += res[0].transcript;
          this.confidence = res[0].confidence;
        } else interim += res[0].transcript;
      }
      this.onInterim((this.finalText + interim).trim());
    };
    r.onerror = (e) => {
      this.error = e.error;
    };
    r.onend = () => this.finish();
    try {
      r.start();
      this.onStatus?.(`Listening (${languageName(this.listenLang)})…`);
    } catch (e) {
      this.onError("start", e.message);
    }
  }

  stop() {
    try {
      this.r?.stop();
    } catch {
      /* already stopped */
    }
  }

  async finish() {
    if (this.done) return;
    this.done = true;
    const wav = this.rec ? await this.rec.stop() : null;
    if (this.error === "not-allowed" || this.error === "service-not-allowed") return this.onError("not-allowed", "Microphone permission is needed.");
    const text = this.finalText.trim();
    // Auto: the browser recognizer can't tell which language was spoken — it
    // writes everything in the language it listened in, confidently. So the
    // clip is always checked by Gemini; the browser text was only the preview.
    let skipWhy = this.skipWhy || "";
    if (this.auto && !this.settings.apiKey) skipWhy = "no Gemini key";
    else if (this.auto && !skipWhy && !wav) skipWhy = "the recorded clip was empty";
    if (this.auto && wav) {
      this.onStatus?.("Identifying the language you spoke…");
      try {
        const j = await identifySpeech(wav, this.settings, text ? { text, lang: this.listenLang } : null);
        if (j?.transcript?.trim()) return this.onDone({ text: j.transcript.trim(), lang: fullTag(j.language_code || this.listenLang), via: "gemini" });
        skipWhy = "Gemini returned no transcript";
      } catch (e) {
        if (!text) return this.onError("identify", `Couldn't identify the language (${e.message}).`);
        skipWhy = `Gemini check failed: ${e.message}`;
      }
    }
    if (text) {
      const base = await identifyLanguage(text, this.listenLang);
      const lang = base === baseOf(this.listenLang) ? this.listenLang : fullTag(base);
      return this.onDone({ text, lang, via: "browser", note: this.auto ? skipWhy : "" });
    }
    this.onError(this.error || "no-speech", this.error === "network" ? "Chrome's speech service is unreachable." : "Didn't catch that — try again, or pick your language.");
  }
}
