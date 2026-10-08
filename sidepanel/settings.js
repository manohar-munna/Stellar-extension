// Persisted settings (chrome.storage.local — never synced off-device).

export const DEFAULTS = {
  apiKey: "",
  reasonModel: "gemini-3.6-flash",
  // Lite is plenty for "find the sensitive boxes" and is far less congested.
  detectModel: "gemini-3.5-flash-lite",
  // "vision" = Gemini finds PII in the raw frame (stand-in for the on-device
  // ONNX detector in the design), merged with local DOM detection.
  // "dom" = DOM-only detection; the raw frame never leaves the machine.
  detector: "vision",
  redactStyle: "solid",
  askRisky: true,
  maxSteps: 15,
  presenter: false,
  theme: "system", // "system" | "light" | "dark"
  // "guided" pauses briefly after every stage so people can follow along;
  // "fast" runs at full speed.
  pace: "guided",
  // On-device FastVLM: "auto" = backup when Gemini fails, "always" = local
  // only (nothing sent to the cloud), "off" = never.
  localBackup: "auto",
  localPreload: true,
  // Vault import: "local" (on-device) or "gemini" (uploads the document).
  vaultExtract: "local",
  // Record Gemini-decided steps as fine-tuning examples (sanitized data only).
  collectTraining: false,
  trainingSource: "user",
  vault: "",
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}
