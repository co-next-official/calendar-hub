import { beforeEach, describe, expect, it } from "vitest";
import { findFreeWindows, mergeIntervals } from "../src/availability/find";
import { login, resetDb, testApp } from "./helpers";

beforeEach(resetDb);

const ms = (iso: string) => Date.parse(iso);

describe("findFreeWindows", () => {
  it("merges overlapping busy time and returns gaps inside the day window", () => {
    expect(mergeIntervals([{ start: 5, end: 10 }, { start: 1, end: 3 }, { start: 8, end: 12 }])).toEqual([{ start: 1, end: 3 }, { start: 5, end: 12 }]);
    // Tokyo 2027-01-12, window 09:00-18:00 (00:00Z-09:00Z). Busy 10-11 and 10:30-12 local.
    const busy = [
      { start: ms("2027-01-12T01:00:00Z"), end: ms("2027-01-12T02:00:00Z") },
      { start: ms("2027-01-12T01:30:00Z"), end: ms("2027-01-12T03:00:00Z") },
    ];
    const w = findFreeWindows(busy, { from: "2027-01-12", to: "2027-01-13", dayStart: "09:00", dayEnd: "18:00", durationMin: 60, timeZone: "Asia/Tokyo" });
    expect(w.map((x) => [new Date(x.start).toISOString(), new Date(x.end).toISOString()])).toEqual([
      ["2027-01-12T00:00:00.000Z", "2027-01-12T01:00:00.000Z"],
      ["2027-01-12T03:00:00.000Z", "2027-01-12T09:00:00.000Z"],
    ]);
  });

  it("drops gaps shorter than the duration", () => {
    const busy = [{ start: ms("2027-01-12T00:30:00Z"), end: ms("2027-01-12T09:00:00Z") }];
    expect(findFreeWindows(busy, { from: "2027-01-12", to: "2027-01-13", dayStart: "09:00", dayEnd: "18:00", durationMin: 60, timeZone: "Asia/Tokyo" })).toEqual([]);
  });
});

describe("/api/availability", () => {
  async function setup() {
    const t = testApp();
    const as = async (sub: string, email: string) => {
      const { cookie } = await login(t, { sub, email });
      return async (method: string, path: string, body?: unknown) => {
        const res = await t.request(path, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        return { status: res.status, body: JSON.parse(text) as Record<string, any>, text };
      };
    };
    return { as };
  }

  it("finds common free time for a group without revealing anyone's events", async () => {
    const { as } = await setup();
    const alice = await as("a", "alice@example.com"), bob = await as("b", "bob@example.com"), carol = await as("c", "carol@example.com");
    const { body: g } = await alice("POST", "/api/groups", { name: "g" });
    await alice("POST", `/api/groups/${g.id}/members`, { email: "bob@example.com" });
    await bob("POST", `/api/groups/${g.id}/accept`);

    await alice("POST", "/api/events", { title: "Aliceの秘密の用事", start_at: "2027-01-12T09:00:00+09:00", end_at: "2027-01-12T12:00:00+09:00" });
    await bob("POST", "/api/events", { title: "Bobの通院", start_at: "2027-01-12T13:00:00+09:00", end_at: "2027-01-12T15:00:00+09:00" });
    await carol("POST", "/api/events", { title: "部外者", start_at: "2027-01-12T16:00:00+09:00", end_at: "2027-01-12T18:00:00+09:00" });

    const res = await alice("GET", `/api/availability?group_id=${g.id}&from=2027-01-12&to=2027-01-13&duration=60&day_start=09:00&day_end=18:00&timezone=Asia/Tokyo`);
    expect(res.status).toBe(200);
    expect(res.body.members).toBe(2);
    expect(res.body.windows).toEqual([
      { start_at: "2027-01-12T03:00:00.000Z", end_at: "2027-01-12T04:00:00.000Z" },
      { start_at: "2027-01-12T06:00:00.000Z", end_at: "2027-01-12T09:00:00.000Z" }, // carol is not a member
    ]);
    expect(res.text).not.toContain("秘密");
    expect(res.text).not.toContain("通院");

    expect((await carol("GET", `/api/availability?group_id=${g.id}&from=2027-01-12&to=2027-01-13`)).status).toBe(404);
  });

  it("ignores all-day events unless asked", async () => {
    const { as } = await setup();
    const alice = await as("a", "alice@example.com");
    await alice("POST", "/api/events", { title: "祝日", all_day: true, start_date: "2027-01-12" });
    const base = "/api/availability?from=2027-01-12&to=2027-01-13&duration=60&day_start=09:00&day_end=18:00&timezone=Asia/Tokyo";
    expect((await alice("GET", base)).body.windows).toHaveLength(1);
    expect((await alice("GET", `${base}&include_all_day=true`)).body.windows).toEqual([]);
  });

  it("validates the query", async () => {
    const { as } = await setup();
    const alice = await as("a", "alice@example.com");
    expect((await alice("GET", "/api/availability?from=2027-01-01&to=2027-03-01")).body.error).toBe("range_too_long");
    expect((await alice("GET", "/api/availability?from=2027-01-01&to=2027-01-02&duration=5")).body.error).toBe("invalid_duration");
  });
});

describe("double-booking warning", () => {
  it("returns overlapping own events on create", async () => {
    const t = testApp();
    const { cookie } = await login(t, { sub: "a", email: "alice@example.com" });
    const post = async (body: unknown) => (await t.request("/api/events", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<Record<string, any>>;
    const first = await post({ title: "会議A", start_at: "2027-01-12T10:00:00+09:00", end_at: "2027-01-12T11:00:00+09:00" });
    expect(first.conflicts).toEqual([]);
    const second = await post({ title: "会議B", start_at: "2027-01-12T10:30:00+09:00", end_at: "2027-01-12T11:30:00+09:00" });
    expect(second.conflicts).toMatchObject([{ title: "会議A" }]);
  });
});
