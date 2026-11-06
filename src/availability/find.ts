// Pure scheduling math: merge busy intervals and find free windows inside daily working hours.
import { zonedToUtc } from "../events/legacy";
import { addDays } from "../events/validate";

export type Interval = { start: number; end: number }; // epoch ms, end exclusive

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** Busy intervals for an all-day event, interpreted in the searcher's timezone. */
export function allDayToInterval(startDate: string, endDate: string, timeZone: string): Interval {
  return { start: Date.parse(zonedToUtc(startDate, "00:00", timeZone)), end: Date.parse(zonedToUtc(endDate, "00:00", timeZone)) };
}

export type FindOptions = {
  from: string; // date, inclusive
  to: string; // date, exclusive
  dayStart: string; // HH:MM
  dayEnd: string; // HH:MM
  durationMin: number;
  timeZone: string;
  notBefore?: number; // epoch ms; ignore time before this (e.g. now)
  limit?: number;
};

/** Free windows of at least durationMin, within [dayStart, dayEnd) of each day, avoiding busy. */
export function findFreeWindows(busy: Interval[], o: FindOptions): Interval[] {
  const merged = mergeIntervals(busy);
  const need = o.durationMin * 60_000;
  const out: Interval[] = [];
  for (let d = o.from; d < o.to; d = addDays(d, 1)) {
    let cursor = Date.parse(zonedToUtc(d, o.dayStart, o.timeZone));
    const dayEnd = Date.parse(zonedToUtc(d, o.dayEnd, o.timeZone));
    if (o.notBefore && cursor < o.notBefore) cursor = Math.ceil(o.notBefore / 900_000) * 900_000; // next quarter hour
    for (const b of merged) {
      if (b.end <= cursor) continue;
      if (b.start >= dayEnd) break;
      if (b.start - cursor >= need) out.push({ start: cursor, end: Math.min(b.start, dayEnd) });
      cursor = Math.max(cursor, b.end);
      if (cursor >= dayEnd) break;
    }
    if (dayEnd - cursor >= need) out.push({ start: cursor, end: dayEnd });
    if (o.limit && out.length >= o.limit) return out.slice(0, o.limit);
  }
  return out;
}
