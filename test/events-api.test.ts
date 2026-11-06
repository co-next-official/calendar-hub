import { beforeEach, describe, expect, it } from "vitest";
import { zonedToUtc } from "../src/events/legacy";
import { login, resetDb, testApp } from "./helpers";

beforeEach(resetDb);

async function setup() {
  const t = testApp();
  const alice = (await login(t, { sub: "a", email: "alice@example.com" })).cookie;
  const bob = (await login(t, { sub: "b", email: "bob@example.com" })).cookie;
  const call = async (cookie: string, method: string, path: string, body?: unknown) => {
    const res = await t.request(path, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { alice, bob, call };
}

const timed = { title: "定例", start_at: "2026-11-10T10:00:00+09:00", end_at: "2026-11-10T11:00:00+09:00", category: "work" };

describe("/api/events", () => {
  it("creates, lists, updates and deletes the caller's events", async () => {
    const { alice, call } = await setup();
    const created = await call(alice, "POST", "/api/events", timed);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "定例", start_at: "2026-11-10T01:00:00.000Z", version: 1, category: "work" });
    expect(created.body).not.toHaveProperty("owner_id");

    const list = await call(alice, "GET", "/api/events?from=2026-11-01&to=2026-12-01");
    expect(list.body.events).toHaveLength(1);

    const patched = await call(alice, "PATCH", `/api/events/${created.body.id}`, { version: 1, title: "定例（延長）", end_at: "2026-11-10T12:00:00+09:00" });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ title: "定例（延長）", end_at: "2026-11-10T03:00:00.000Z", version: 2 });

    expect((await call(alice, "DELETE", `/api/events/${created.body.id}`)).status).toBe(200);
    expect((await call(alice, "GET", `/api/events/${created.body.id}`)).status).toBe(404);
  });

  it("hides other users' events behind 404 on every route", async () => {
    const { alice, bob, call } = await setup();
    const { body: e } = await call(alice, "POST", "/api/events", timed);
    expect((await call(bob, "GET", "/api/events?from=2026-11-01&to=2026-12-01")).body.events).toEqual([]);
    expect((await call(bob, "GET", `/api/events/${e.id}`)).status).toBe(404);
    expect((await call(bob, "PATCH", `/api/events/${e.id}`, { version: 1, title: "x" })).status).toBe(404);
    expect((await call(bob, "DELETE", `/api/events/${e.id}`)).status).toBe(404);
    expect((await call(alice, "GET", `/api/events/${e.id}`)).body.title).toBe("定例");
  });

  it("returns 409 with the current row for a stale version", async () => {
    const { alice, call } = await setup();
    const { body: e } = await call(alice, "POST", "/api/events", timed);
    await call(alice, "PATCH", `/api/events/${e.id}`, { version: 1, title: "tab A" });
    const stale = await call(alice, "PATCH", `/api/events/${e.id}`, { version: 1, title: "tab B" });
    expect(stale.status).toBe(409);
    expect(stale.body.current).toMatchObject({ title: "tab A", version: 2 });
  });

  it("validates input and query ranges", async () => {
    const { alice, call } = await setup();
    expect((await call(alice, "POST", "/api/events", { title: "" })).status).toBe(400);
    expect((await call(alice, "PATCH", "/api/events/whatever", { title: "x" })).body.error).toBe("version_required");
    expect((await call(alice, "GET", "/api/events")).status).toBe(400);
    expect((await call(alice, "GET", "/api/events?from=2026-01-01&to=2028-01-01")).body.error).toBe("range_too_long");
  });
});

describe("/api/import/calendar-hub", () => {
  const legacy = {
    events: [
      { id: "6f1c-legacy-1", title: "歯医者", date: "2026-11-12", allDay: false, start: "15:00", end: "16:00", category: "personal" },
      { id: "6f1c-legacy-2", title: "祝日", date: "2026-11-23", allDay: true, start: null, end: null, category: "personal" },
      { id: "6f1c-legacy-3", title: "壊れた", date: "2026-02-30", allDay: true, category: "personal" },
    ],
  };

  it("imports old events as the caller, idempotently", async () => {
    const { alice, bob, call } = await setup();
    const first = await call(alice, "POST", "/api/import/calendar-hub", legacy);
    expect(first.body).toMatchObject({ created: 2, skipped: 0 });
    expect(first.body.failed).toEqual([{ index: 2, error: "invalid_start_date" }]);
    expect((await call(alice, "POST", "/api/import/calendar-hub", legacy)).body).toMatchObject({ created: 0, skipped: 2 });

    const list = (await call(alice, "GET", "/api/events?from=2026-11-01&to=2026-12-01")).body.events;
    expect(list.map((e: any) => e.title).sort()).toEqual(["歯医者", "祝日"]);
    expect(list.find((e: any) => e.title === "歯医者")).toMatchObject({ start_at: "2026-11-12T06:00:00.000Z", source: "import" });
    // Same old ids under another account are separate events.
    expect((await call(bob, "POST", "/api/import/calendar-hub", legacy)).body.created).toBe(2);
  });

  it("converts wall-clock times across DST", () => {
    expect(zonedToUtc("2026-03-08", "03:30", "America/New_York")).toBe("2026-03-08T07:30:00.000Z");
    expect(zonedToUtc("2026-07-01", "09:00", "Europe/London")).toBe("2026-07-01T08:00:00.000Z");
    expect(zonedToUtc("2026-11-12", "15:00", "Asia/Tokyo")).toBe("2026-11-12T06:00:00.000Z");
  });
});
