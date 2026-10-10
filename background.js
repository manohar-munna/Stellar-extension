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
// Alarms are handled one after another, so two schedules due at the same
// minute can't both see "nothing running" and open two windows.
let alarmQueue = Promise.resolve();
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  alarmQueue = alarmQueue.then(() => onScheduleAlarm(alarm)).catch((err) => console.error("[stellar] scheduled task failed to start", err));
});

async function onScheduleAlarm(alarm) {
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
  const win = await openRunner(id);
  await chrome.storage.session.set({ schedRunning: { id, at: Date.now(), winId: win?.id } });
}

// Clicking a notification: "needs you" brings the running task's own window
// forward (only it can approve); "finished" shows the result.
chrome.notifications.onClicked.addListener(async (nid) => {
  if (!nid.startsWith("stellar-")) return;
  chrome.notifications.clear(nid);
  if (nid.startsWith("stellar-wait-")) {
    const { schedRunning } = await chrome.storage.session.get("schedRunning");
    if (schedRunning?.winId && (await chrome.windows.update(schedRunning.winId, { focused: true }).catch(() => null))) return;
  }
  chrome.windows.create({ url: chrome.runtime.getURL("sidepanel/sidepanel.html?popout=1"), type: "popup", width: 560, height: 960 });
});
