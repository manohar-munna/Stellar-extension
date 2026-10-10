// Scheduled tasks ("every morning at 9, check train ticket prices and tell
// me"). Kept in chrome.storage.local and fired by chrome.alarms. When one is
// due, the background opens a small Stellar window that runs the task in a
// browser window of its own, then shows the answer as a notification.
// Shared by the service worker and the side panel: no DOM in here.

export const ALARM_PREFIX = "stellar-schedule:";
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
// Chrome was closed at the scheduled time: still run when it opens, up to this late.
export const LATE_LIMIT_MS = 6 * 3_600_000;

export async function listSchedules() {
  const { schedules = [] } = await chrome.storage.local.get("schedules");
  return schedules;
}

async function saveSchedules(list) {
  await chrome.storage.local.set({ schedules: list });
}

export async function upsertSchedule(s) {
  const list = await listSchedules();
  const i = list.findIndex((x) => x.id === s.id);
  if (i >= 0) list[i] = { ...list[i], ...s };
  else list.push(s);
  await saveSchedules(list);
  await armSchedule(list.find((x) => x.id === s.id));
}

export async function updateSchedule(id, patch) {
  const list = await listSchedules();
  const s = list.find((x) => x.id === id);
  if (!s) return null;
  Object.assign(s, patch);
  await saveSchedules(list);
  return s;
}

export async function removeSchedule(id) {
  await saveSchedules((await listSchedules()).filter((x) => x.id !== id));
  await chrome.alarms.clear(ALARM_PREFIX + id);
  await chrome.alarms.clear(`${ALARM_PREFIX}${id}:retry`);
}

/** The next time (epoch ms) a schedule is due after `from`, or null. */
export function nextRun(s, from = Date.now()) {
  if (!s?.days?.length) return null;
  const [hh, mm] = String(s.time || "09:00").split(":").map(Number);
  const d = new Date(from);
  for (let i = 0; i < 8; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hh, mm, 0, 0);
    if (c.getTime() > from + 1000 && s.days.includes(c.getDay())) return c.getTime();
  }
  return null;
}

export async function armSchedule(s) {
  if (!s) return;
  await chrome.alarms.clear(ALARM_PREFIX + s.id);
  const when = s.enabled !== false ? nextRun(s) : null;
  if (when) await chrome.alarms.create(ALARM_PREFIX + s.id, { when });
}

/** Re-create alarms. keepExisting leaves pending ones alone (Chrome fires missed alarms at startup). */
export async function armAll({ keepExisting = false } = {}) {
  const list = await listSchedules();
  const alarms = await chrome.alarms.getAll();
  for (const a of alarms) {
    if (!a.name.startsWith(ALARM_PREFIX)) continue;
    const id = a.name.slice(ALARM_PREFIX.length).split(":")[0];
    if (!list.some((s) => s.id === id && s.enabled !== false)) await chrome.alarms.clear(a.name);
  }
  for (const s of list) {
    if (keepExisting && alarms.some((a) => a.name === ALARM_PREFIX + s.id)) continue;
    await armSchedule(s);
  }
}

function clock(time) {
  const [h, m] = String(time).split(":").map(Number);
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "Every day at 9:00 AM", "Weekdays at 6:30 PM", "Mon, Wed at 8:00 AM". */
export function describeWhen(s) {
  const days = [...(s.days || [])].sort();
  const key = days.join("");
  const which = key === "0123456" ? "Every day" : key === "12345" ? "Weekdays" : key === "06" ? "Weekends" : days.map((d) => DAY_NAMES[d]).join(", ");
  return `${which} at ${clock(s.time)}`;
}

export function describeNext(s) {
  const when = s.enabled !== false ? nextRun(s) : null;
  if (!when) return s.enabled === false ? "Paused" : "Not scheduled";
  const d = new Date(when);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const day = d.toDateString() === today.toDateString() ? "today" : d.toDateString() === tomorrow.toDateString() ? "tomorrow" : DAY_NAMES[d.getDay()];
  return `Next: ${day} ${clock(`${d.getHours()}:${d.getMinutes()}`)}`;
}

const DAY_RE = "(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?s?";

/**
 * Pull the "when" out of a sentence:
 * "Every morning at 9, check train ticket prices and tell me" →
 * { task: "Check train ticket prices and tell me", time: "09:00", days: [0..6], found: true }
 */
export function parseScheduleText(text) {
  let t = ` ${String(text || "")} `;
  let h = null;
  let m = 0;
  let ampm = "";
  const take = (re) => {
    const r = t.match(re);
    if (r) t = t.replace(r[0], " ");
    return r;
  };
  let r = take(/\b(?:at\s+|@\s*|by\s+|around\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i);
  if (r) [h, m, ampm] = [Number(r[1]), Number(r[2] || 0), r[3].toLowerCase()[0]];
  else if ((r = take(/(?:\bat\s+|@\s*)(\d{1,2})(?:[:.](\d{2}))?\b(?!\s*(?:%|rs|₹|km|kg|days?|hours?|hrs?|min|stores?|shops?|sites?|websites?|tabs?|places?|items?|products?|pages?|times?|people|persons?)\b)/i))) [h, m] = [Number(r[1]), Number(r[2] || 0)];
  else if ((r = take(/\b([01]?\d|2[0-3]):([0-5]\d)\b/))) [h, m] = [Number(r[1]), Number(r[2])];

  const part = /\bmorning\b/i.test(t) ? "morning" : /\bafternoon\b/i.test(t) ? "afternoon" : /\bevening\b/i.test(t) ? "evening" : /\b(?:night|tonight)\b/i.test(t) ? "night" : /\bnoon\b/i.test(t) ? "noon" : "";
  if (h == null && part) h = { morning: 9, afternoon: 14, evening: 18, night: 21, noon: 12 }[part];
  if (h != null) {
    if (ampm === "p" && h < 12) h += 12;
    if (ampm === "a" && h === 12) h = 0;
    if (!ampm && h < 12 && ["afternoon", "evening", "night"].includes(part)) h += 12;
    if (!ampm && h === 12 && part === "night") h = 0; // "every night at 12" is midnight
    h = Math.min(23, Math.max(0, h));
    m = Math.min(59, Math.max(0, m || 0));
  }

  let days = null;
  if (/\bweekdays?\b|\bmon(?:day)?\s*(?:to|through|-|–)\s*fri(?:day)?\b/i.test(t)) days = [1, 2, 3, 4, 5];
  else if (/\bweekends?\b/i.test(t)) days = [0, 6];
  else {
    const named = t.match(new RegExp(`\\b(?:every|on|each)\\s+(${DAY_RE}(?:\\s*(?:,|and|&)\\s*${DAY_RE})*)`, "i"));
    if (named) {
      const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      days = [...new Set(named[1].toLowerCase().match(/sun|mon|tue|wed|thu|fri|sat/g).map((d) => map[d]))].sort();
    } else if (/\b(?:every|each)\s+(?:day|morning|afternoon|evening|night)\b|\b(?:daily|everyday)\b/i.test(t)) days = [...EVERY_DAY];
    else if (/\btomorrow\b/i.test(t)) days = [(new Date().getDay() + 1) % 7];
    else if (/\btoday\b/i.test(t) && h != null) days = [new Date().getDay()];
  }
  // "every 2 hours" — schedules run at set times on chosen days, not on an interval.
  const interval = /\bevery\s+(?:\d+\s*|few\s+|couple of\s+)?(?:hours?|hrs?|minutes?|mins?)\b/i.test(t);
  const found = !interval && (h != null || days != null || /\b(?:every|each|daily|everyday)\b/i.test(t));

  // What's left is the task itself.
  t = t
    .replace(/\b(?:(?:every|each|on|from)\s+)?mon(?:day)?\s*(?:to|through|-|–)\s*fri(?:day)?\b/gi, " ")
    .replace(/\b(?:tomorrow|today)\b/gi, " ")
    .replace(new RegExp(`\\b(?:every|each|on)\\s+(?:day|morning|afternoon|evening|night|weekdays?|weekends?|${DAY_RE})(?:\\s*(?:,|and|&)\\s*(?:${DAY_RE}))*\\b`, "gi"), " ")
    .replace(/\bmon(?:day)?\s*(?:to|through|-|–)\s*fri(?:day)?\b/gi, " ")
    .replace(/\b(?:daily|everyday|tonight)\b/gi, " ")
    .replace(/\b(?:in the|at)\s+(?:morning|afternoon|evening|night|noon)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.-]+|[\s,;:-]+$/g, "")
    .replace(/^(?:and|then)\s+/i, "");
  const task = t ? t[0].toUpperCase() + t.slice(1) : "";
  return {
    task,
    time: h != null ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` : null,
    days,
    found,
    interval,
  };
}

/** chrome.windows.create at a position, or wherever Chrome likes if that position is refused (off screen). */
export async function createWindowAt(opts, geo) {
  try {
    return await chrome.windows.create({ ...opts, ...geo });
  } catch {
    return chrome.windows.create(opts);
  }
}

/** A small Stellar window at the right edge of the browser that runs schedule `id`. */
export async function openRunner(id) {
  const W = 470;
  const base = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const geo = base?.width > W + 600 ? { left: base.left + base.width - W, top: base.top, width: W, height: base.height } : { width: W, height: 900 };
  return createWindowAt({ url: chrome.runtime.getURL(`sidepanel/sidepanel.html?popout=1&scheduled=${encodeURIComponent(id)}`), type: "popup", focused: true }, geo);
}
