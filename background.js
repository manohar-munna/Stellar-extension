// Stellar service worker: clicking the toolbar icon (or Alt+Shift+S) opens the
// side panel, where the whole Capture → Detect → Redact → Reason → Validate →
// Execute pipeline runs and is visualised. It also fires scheduled tasks.

import { ALARM_PREFIX, LATE_LIMIT_MS, armAll, armSchedule, listSchedules, openRunner, updateSchedule } from "./sidepanel/schedules.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[stellar] setPanelBehavior failed", err));
  armAll().catch((err) => console.error("[stellar] scheduling failed", err));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  armAll({ keepExisting: true }).catch(() => {});
});

// A scheduled task is due: open a Stellar window that runs it (one at a time).
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const [id, retry] = alarm.name.slice(ALARM_PREFIX.length).split(":");
  const s = (await listSchedules()).find((x) => x.id === id);
  if (!s || s.enabled === false) return;
  if (!retry) await armSchedule(s); // the next occurrence
  if (Date.now() - alarm.scheduledTime > LATE_LIMIT_MS) {
    await updateSchedule(id, { lastResult: { ok: false, at: Date.now(), message: "Skipped — Chrome wasn't open at the scheduled time." } });
    return;
  }
  const { schedRunning } = await chrome.storage.session.get("schedRunning");
  if (schedRunning && Date.now() - schedRunning.at < 30 * 60_000) {
    chrome.alarms.create(`${ALARM_PREFIX}${id}:retry`, { when: Date.now() + 5 * 60_000 });
    return;
  }
  await chrome.storage.session.set({ schedRunning: { id, at: Date.now() } });
  await openRunner(id);
});

// Clicking a "scheduled task finished" notification shows the result.
chrome.notifications.onClicked.addListener((nid) => {
  if (!nid.startsWith("stellar-")) return;
  chrome.notifications.clear(nid);
  chrome.windows.create({ url: chrome.runtime.getURL("sidepanel/sidepanel.html?popout=1"), type: "popup", width: 560, height: 960 });
});
