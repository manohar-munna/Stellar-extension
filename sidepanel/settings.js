// Persisted settings (chrome.storage.local — never synced off-device).

export const DEFAULTS = {
  apiKey: "",
  reasonModel: "gemini-3.6-flash",
  // Lite is plenty for "find the sensitive boxes" and is far less congested.
  detectModel: "gemini-3.5-flash-lite",
  // "local" (default) = DOM rules + on-device face detection; the raw frame
  // never leaves the machine (PS 26171: sanitize before any network request).
  // "vision" = also ask Gemini to find PII in the raw frame — a comparison
  // mode that sends the unredacted screenshot to the cloud.
  detector: "local",
  askRisky: true,
  maxSteps: 15,
  presenter: false,
  theme: "system", // "system" | "light" | "dark"
  // "guided" pauses briefly after every stage so people can follow along;
  // "fast" runs at full speed.
  pace: "guided",
  // On-device FastVLM: "localfirst" = decides when confident, Gemini otherwise;
  // "auto" = Gemini decides, on-device takes over when Gemini fails;
  // "always" = on-device only (nothing sent to the cloud); "off" = Gemini only.
  localBackup: "localfirst",
  // "safe" asks before risky actions; "autopilot" runs to the end and only
  // stops for real questions (missing required details, CAPTCHAs).
  runMode: "safe",
  localPreload: true,
  // Unlock browser-autofilled logins with one real click on a blank part of the
  // login form (chrome.debugger, attached for about a second).
  realClick: true,
  // Voice: the language you speak ("auto" identifies it), the last language
  // identified, and whether replies to spoken tasks are read aloud.
  voiceLang: "auto",
  lastVoiceLang: "",
  speakReplies: true,
  // Unload the on-device model after this many idle minutes (0 = never).
  localUnloadMinutes: 10,
  // Vault import: "local" (on-device) or "gemini" (uploads the document).
  vaultExtract: "local",
  // Adding a file to the vault: "extract" details, "store" the file for
  // upload fields, or "both".
  vaultFileMode: "both",
  vault: "",
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get([...Object.keys(DEFAULTS), "privacyV2", "modesV3"]);
  // One-time move to the on-device detector: earlier builds defaulted to the
  // cloud detector, which sends the raw frame before redaction.
  if (!stored.privacyV2) {
    stored.detector = "local";
    await chrome.storage.local.set({ detector: "local", privacyV2: true });
  }
  if (stored.detector === "dom") stored.detector = "local";
  // One-time move from the old "Gemini first" default to Local-first.
  if (!stored.modesV3) {
    if (!stored.localBackup || stored.localBackup === "auto") stored.localBackup = "localfirst";
    await chrome.storage.local.set({ localBackup: stored.localBackup, modesV3: true });
  }
  delete stored.privacyV2;
  delete stored.modesV3;
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}
