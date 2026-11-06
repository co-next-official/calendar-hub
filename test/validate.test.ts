import { describe, expect, it } from "vitest";
import { validateEvent, type EventFields } from "../src/events/validate";

const ok = (input: unknown, base?: EventFields) => {
  const r = validateEvent(input, base);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.value;
};
const err = (input: unknown, base?: EventFields) => {
  const r = validateEvent(input, base);
  return r.ok ? "ok" : r.error;
};

describe("validateEvent", () => {
  it("accepts a timed event and normalizes offsets to UTC", () => {
    const v = ok({ title: " 打ち合わせ ", start_at: "2026-11-10T10:00:00+09:00", end_at: "2026-11-10T11:00:00+09:00", timezone: "Asia/Tokyo" });
    expect(v).toMatchObject({ title: "打ち合わせ", allDay: false, startAt: "2026-11-10T01:00:00.000Z", endAt: "2026-11-10T02:00:00.000Z", startDate: null });
  });

  it("defaults an all-day event to one day with an exclusive end date", () => {
    const v = ok({ title: "祝日", all_day: true, start_date: "2026-12-31" });
    expect(v).toMatchObject({ allDay: true, startDate: "2026-12-31", endDate: "2027-01-01", startAt: null });
  });

  it("infers all-day from start_date when all_day is omitted", () => {
    expect(ok({ title: "旅行", start_date: "2026-11-20", end_date: "2026-11-23" }).allDay).toBe(true);
  });

  it("rejects bad titles, dates, ranges, categories and timezones", () => {
    expect(err({ title: " ", all_day: true, start_date: "2026-11-05" })).toBe("invalid_title");
    expect(err({ title: "a".repeat(121), all_day: true, start_date: "2026-11-05" })).toBe("invalid_title");
    expect(err({ title: "x", all_day: true, start_date: "2026-02-30" })).toBe("invalid_start_date");
    expect(err({ title: "x", all_day: true, start_date: "2026-11-05", end_date: "2026-11-05" })).toBe("invalid_end_date");
    expect(err({ title: "x", start_at: "2026-11-05T11:00:00Z", end_at: "2026-11-05T10:00:00Z" })).toBe("invalid_end_at");
    expect(err({ title: "x", start_at: "2026-11-05T10:00:00", end_at: "2026-11-05T11:00:00Z" })).toBe("invalid_start_at");
    expect(err({ title: "x", start_at: "2026-11-01T00:00:00Z", end_at: "2026-12-15T00:00:00Z" })).toBe("range_too_long");
    expect(err({ title: "x", all_day: true, start_date: "2026-11-05", category: "secret" })).toBe("invalid_category");
    expect(err({ title: "x", all_day: true, start_date: "2026-11-05", timezone: "Mars/Base" })).toBe("invalid_timezone");
    expect(err([])).toBe("invalid_body");
  });

  it("applies partial updates on top of the current values", () => {
    const base = ok({ title: "会議", start_at: "2026-11-10T01:00:00Z", end_at: "2026-11-10T02:00:00Z" });
    expect(ok({ title: "定例" }, base)).toMatchObject({ title: "定例", startAt: base.startAt, endAt: base.endAt });
    expect(ok({ all_day: true, start_date: "2026-11-10" }, base)).toMatchObject({ allDay: true, startDate: "2026-11-10", endDate: "2026-11-11", startAt: null });
    expect(err({ end_at: "2026-11-10T00:30:00Z" }, base)).toBe("invalid_end_at");
  });
});
