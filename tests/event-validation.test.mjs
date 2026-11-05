import test from "node:test";
import assert from "node:assert/strict";
import { isValidEvent, parseEventInput, validDate } from "../app/event-validation.ts";

test("accepts timed events with a real date and ordered same-day times", () => {
  const event = parseEventInput({ title: "打ち合わせ", date: "2026-11-05", allDay: false, start: "09:30", end: "10:30", category: "work" });
  assert.equal(isValidEvent(event), true);
});

test("accepts all-day events without times and rejects unknown category", () => {
  const event = parseEventInput({ title: "祝日", date: "2026-11-05", allDay: true, category: "unknown" });
  assert.equal(isValidEvent(event), false);
  const valid = parseEventInput({ title: "祝日", date: "2026-11-05", allDay: true, category: "personal" });
  assert.equal(isValidEvent(valid), true);
});

test("rejects invalid dates, empty/long titles, and invalid or reversed time ranges", () => {
  assert.equal(validDate("2026-02-30"), false);
  assert.equal(isValidEvent(parseEventInput({ title: " ", date: "2026-11-05", allDay: true })), false);
  assert.equal(isValidEvent(parseEventInput({ title: "a".repeat(121), date: "2026-11-05", allDay: true })), false);
  assert.equal(isValidEvent(parseEventInput({ title: "会議", date: "2026-11-05", start: "11:00", end: "10:00" })), false);
  assert.equal(isValidEvent(parseEventInput({ title: "会議", date: "2026-11-05", start: "25:00", end: "26:00" })), false);
});
