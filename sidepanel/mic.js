// One-time microphone permission for the extension (the side panel can't prompt).
const state = document.getElementById("state");
navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((stream) => {
    stream.getTracks().forEach((t) => t.stop());
    state.className = "ok";
    state.textContent = "Microphone allowed — go back to the Stellar panel and press 🎤 again. This tab closes by itself.";
    chrome.runtime.sendMessage({ type: "stellar-mic-granted" }).catch(() => {});
    setTimeout(() => window.close(), 2500);
  })
  .catch((e) => {
    state.className = "bad";
    state.textContent =
      e?.name === "NotAllowedError"
        ? "Microphone blocked. Click the icon at the left of the address bar → Site settings → Microphone → Allow, then reload this tab."
        : `Couldn't open the microphone: ${e?.message || e}`;
  });
