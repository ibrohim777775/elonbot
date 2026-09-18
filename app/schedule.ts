// All daily sending windows use the same explicit timezone, independent of the server's local clock.
export const sendingTimeZone = "Asia/Tashkent";
const localClock = new Intl.DateTimeFormat("en-GB", { timeZone: sendingTimeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export interface SendingWindow { send_start_minute?: number | null; send_end_minute?: number | null }

export function validSendingWindow(window: SendingWindow) {
  const start = window.send_start_minute, end = window.send_end_minute;
  if (start == null && end == null) return true;
  return Number.isInteger(start) && Number.isInteger(end) && start! >= 0 && start! < 1440 && end! >= 0 && end! <= 1440 && start !== end;
}
export function parseSendingWindow(value: string): SendingWindow | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return;
  const [startHour, startMinute, endHour, endMinute] = [Number(match[1]), Number(match[2] ?? 0), Number(match[3]), Number(match[4] ?? 0)];
  if (startHour > 23 || endHour > 24 || startMinute > 59 || endMinute > 59 || (endHour === 24 && endMinute !== 0)) return;
  const window = { send_start_minute: startHour * 60 + startMinute, send_end_minute: endHour * 60 + endMinute };
  return validSendingWindow(window) ? window : undefined;
}
export function parseClockTime(value: string, end = false): number | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return;
  const hour = Number(match[1]), minute = Number(match[2] ?? 0);
  if (minute > 59 || hour > (end ? 24 : 23) || (hour === 24 && minute !== 0)) return;
  return hour * 60 + minute;
}
export function formatMinute(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
function minuteOfDay(at: Date) {
  const parts = localClock.formatToParts(at);
  return Number(parts.find(p => p.type === "hour")!.value) * 60 + Number(parts.find(p => p.type === "minute")!.value) + at.getUTCSeconds() / 60 + at.getUTCMilliseconds() / 60_000;
}
function inside(minute: number, start: number, end: number) {
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
// Tashkent has no daylight-saving transitions; advancing to a local minute uses a 24-hour day.
export function nextSendingTime(at: Date, window: SendingWindow): Date {
  if (!validSendingWindow(window)) throw new Error("INVALID_SENDING_WINDOW");
  const start = window.send_start_minute, end = window.send_end_minute;
  if (start == null || end == null) return at;
  const minute = minuteOfDay(at);
  if (inside(minute, start, end)) return at;
  return new Date(at.getTime() + Math.round(((start - minute + 1440) % 1440) * 60_000));
}
export function sendingDeadline(at: Date, window: SendingWindow): number | undefined {
  if (!validSendingWindow(window)) throw new Error("INVALID_SENDING_WINDOW");
  const start = window.send_start_minute, end = window.send_end_minute;
  if (start == null || end == null || (start === 0 && end === 1440)) return;
  const minute = minuteOfDay(at);
  if (!inside(minute, start, end)) return at.getTime();
  return at.getTime() + Math.round(((end - minute + 1440) % 1440) * 60_000);
}
