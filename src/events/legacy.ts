// Converts the old ChatGPT Sites Calendar Hub event shape
// ({ id, title, date: "YYYY-MM-DD", allDay, start: "HH:MM", end: "HH:MM", category }, local wall-clock time)
// into Orbit-style fields with UTC instants.
import { validateEvent, type ValidationResult } from "./validate";

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Offset of `timeZone` from UTC, in minutes, at the given instant. */
function offsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Interprets a wall-clock date + time in `timeZone` and returns the UTC instant. */
export function zonedToUtc(date: string, time: string, timeZone: string): string {
  const naive = Date.parse(`${date}T${time}:00Z`);
  let guess = naive - offsetMinutes(timeZone, new Date(naive)) * 60_000;
  guess = naive - offsetMinutes(timeZone, new Date(guess)) * 60_000; // second pass settles DST edges
  return new Date(guess).toISOString();
}

export function convertLegacyEvent(item: unknown, timeZone: string): ValidationResult {
  if (!item || typeof item !== "object") return { ok: false, error: "invalid_item" };
  const e = item as Record<string, unknown>;
  const category = e.category ?? "personal";
  if (e.allDay === true) {
    return validateEvent({ title: e.title, category, all_day: true, start_date: e.date, timezone: timeZone });
  }
  if (typeof e.date !== "string" || typeof e.start !== "string" || typeof e.end !== "string" || !TIME_RE.test(e.start) || !TIME_RE.test(e.end)) {
    return { ok: false, error: "invalid_time" };
  }
  return validateEvent({
    title: e.title, category, all_day: false, timezone: timeZone,
    start_at: zonedToUtc(e.date, e.start, timeZone), end_at: zonedToUtc(e.date, e.end, timeZone),
  });
}
