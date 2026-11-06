import { describe, expect, it } from "vitest";
import { dueReminders } from "../src/reminders/due";

const NOW = Date.parse("2027-01-12T10:00:00.000Z");
const SINCE = NOW - 15 * 60000; // previous cron tick, 15 min ago
const iso = (ms: number) => new Date(ms).toISOString();
const min = (n: number) => n * 60000;

describe("dueReminders", () => {
  it("fires when the lead time lands at (inclusive) now", () => {
    const r = dueReminders([{ eventId: "a", startAt: iso(NOW + min(10)), minutesBefore: 10, sentAt: null }], NOW, SINCE);
    expect(r).toEqual([{ eventId: "a", fireAt: NOW }]);
  });

  it("does not fire before the lead time is reached", () => {
    expect(dueReminders([{ eventId: "a", startAt: iso(NOW + min(60)), minutesBefore: 10, sentAt: null }], NOW, SINCE)).toEqual([]);
  });

  it("skips reminders already sent", () => {
    expect(dueReminders([{ eventId: "a", startAt: iso(NOW + min(5)), minutesBefore: 10, sentAt: "2027-01-12T09:50:00Z" }], NOW, SINCE)).toEqual([]);
  });

  it("skips fire times at or before the previous tick (no duplicate/stale sends)", () => {
    // start now+5, lead 25 -> fireAt = now-20min < since(now-15)
    expect(dueReminders([{ eventId: "a", startAt: iso(NOW + min(5)), minutesBefore: 25, sentAt: null }], NOW, SINCE)).toEqual([]);
  });

  it("skips events that have already started even if the fire time is in the window", () => {
    const since = NOW - min(60);
    expect(dueReminders([{ eventId: "a", startAt: iso(NOW - min(1)), minutesBefore: 30, sentAt: null }], NOW, since)).toEqual([]);
  });

  it("ignores negative lead times and unparseable start times", () => {
    expect(dueReminders([{ eventId: "a", startAt: iso(NOW + min(10)), minutesBefore: -5, sentAt: null }], NOW, SINCE)).toEqual([]);
    expect(dueReminders([{ eventId: "a", startAt: "not-a-date", minutesBefore: 10, sentAt: null }], NOW, SINCE)).toEqual([]);
  });

  it("returns due reminders sorted by fire time, ties keeping input order", () => {
    const since = NOW - min(20);
    const cands = [
      { eventId: "late", startAt: iso(NOW + min(10)), minutesBefore: 5, sentAt: null }, // fireAt now+5 -> excluded (future)
      { eventId: "b", startAt: iso(NOW + min(5)), minutesBefore: 10, sentAt: null }, // fireAt now-5
      { eventId: "a", startAt: iso(NOW + min(10)), minutesBefore: 15, sentAt: null }, // fireAt now-5 (tie, after b)
      { eventId: "c", startAt: iso(NOW + min(1)), minutesBefore: 2, sentAt: null }, // fireAt now-1
    ];
    expect(dueReminders(cands, NOW, since).map((x) => x.eventId)).toEqual(["b", "a", "c"]);
  });
});
