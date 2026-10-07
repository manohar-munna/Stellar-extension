// Stellar service worker: clicking the toolbar icon (or Alt+Shift+S) opens the
// side panel, where the whole Capture → Detect → Redact → Reason → Validate →
// Execute pipeline runs and is visualised.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[stellar] setPanelBehavior failed", err));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
