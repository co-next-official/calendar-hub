import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { GoogleAuthError, SyncTokenExpired, type EventsPage, type GoogleApi } from "../src/google/client";
import { open, seal } from "../src/lib/secretbox";
import { fakeGoogle, login, resetDb, testApp } from "./helpers";

beforeEach(resetDb);

/** A fake Google Calendar whose server-side state the test controls. */
function fakeCalendar() {
  const calls: { syncToken?: string; timeMin?: string; pageToken?: string }[] = [];
  let pages: EventsPage[] = [];
  let failNext: Error | null = null;
  const revoked: string[] = [];
  const api: GoogleApi = fakeGoogle({
    exchangeCalendarCode: async ({ code }) => {
      if (code !== "good-code") throw new GoogleAuthError("bad code");
      return { refreshToken: "refresh-SECRET", accessToken: "access-SECRET", expiresIn: 3600, email: "me@gmail.com" };
    },
    listEvents: async (p) => {
      calls.push({ syncToken: p.syncToken, timeMin: p.timeMin, pageToken: p.pageToken });
      if (failNext) { const e = failNext; failNext = null; throw e; }
      const idx = p.pageToken ? Number(p.pageToken) : 0;
      return pages[idx] ?? { items: [] };
    },
    revoke: async (token) => { revoked.push(token); },
  });
  return { api, calls, revoked, setPages: (p: EventsPage[]) => { pages = p; }, failOnce: (e: Error) => { failNext = e; } };
}

async function connect(cal: ReturnType<typeof fakeCalendar>) {
  const t = testApp(cal.api);
  const { cookie } = await login(t, { sub: "a", email: "me@example.com" });
  const start = await t.request("/auth/google/calendar/connect", { headers: { cookie } });
  const url = new URL(start.headers.get("location")!);
  const state = url.searchParams.get("state")!;
  const gcal = start.headers.getSetCookie().find((c) => c.startsWith("ch_gcal="))!.split(";")[0]!;
  const cb = await t.request(`/auth/google/calendar/callback?code=good-code&state=${state}`, { headers: { cookie: `${cookie}; ${gcal}` } });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await t.request(path, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { t, cookie, url, cb, call };
}

const RANGE = "/api/events?from=2026-11-01&to=2027-01-01";
const timed = (id: string, summary: string, s: string, e: string) => ({ id, summary, start: { dateTime: s, timeZone: "Asia/Tokyo" }, end: { dateTime: e } });

describe("Google Calendar connection", () => {
  it("asks for read-only calendar access with offline consent", async () => {
    const cal = fakeCalendar();
    const { url, cb } = await connect(cal);
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(cb.headers.get("location")).toBe("/?google=connected");
  });

  it("stores tokens encrypted, never in plain text", async () => {
    const cal = fakeCalendar();
    await connect(cal);
    const row = await env.DB.prepare("SELECT * FROM google_connections").first<Record<string, string>>();
    expect(JSON.stringify(row)).not.toContain("refresh-SECRET");
    expect(JSON.stringify(row)).not.toContain("access-SECRET");
    expect(await open(row!.refresh_token_enc!, env.GOOGLE_TOKEN_KEY)).toBe("refresh-SECRET");
  });

  it("rejects a callback that does not belong to the signed-in user", async () => {
    const cal = fakeCalendar();
    const t = testApp(cal.api);
    const alice = (await login(t, { sub: "a", email: "alice@example.com" })).cookie;
    const bob = (await login(t, { sub: "b", email: "bob@example.com" })).cookie;
    const start = await t.request("/auth/google/calendar/connect", { headers: { cookie: alice } });
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const gcal = start.headers.getSetCookie().find((c) => c.startsWith("ch_gcal="))!.split(";")[0];
    const cb = await t.request(`/auth/google/calendar/callback?code=good-code&state=${state}`, { headers: { cookie: `${bob}; ${gcal}` } });
    expect(cb.headers.get("location")).toBe("/?google=state_error");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM google_connections").first("n")).toBe(0);
  });
});

describe("Google Calendar sync", () => {
  it("mirrors events, applies incremental changes and cancellations, and keeps them read-only", async () => {
    const cal = fakeCalendar();
    cal.setPages([
      { items: [timed("g1", "歯科", "2026-11-12T15:00:00+09:00", "2026-11-12T16:00:00+09:00")], nextPageToken: "1" },
      { items: [{ id: "g2", summary: "連休", start: { date: "2026-11-21" }, end: { date: "2026-11-24" } }, timed("rec_20261113", "定例（繰り返し）", "2026-11-13T10:00:00+09:00", "2026-11-13T11:00:00+09:00")], nextSyncToken: "sync-1" },
    ]);
    const { call } = await connect(cal);
    expect(cal.calls[0]!.timeMin).toBeTruthy();

    let list = (await call("GET", RANGE)).body.events;
    expect(list.map((e: any) => e.title).sort()).toEqual(["定例（繰り返し）", "歯科", "連休"]);
    expect(list.find((e: any) => e.title === "連休")).toMatchObject({ all_day: true, start_date: "2026-11-21", end_date: "2026-11-24", source: "google" });
    const dentist = list.find((e: any) => e.title === "歯科");

    // Incremental: one renamed, one recurring instance cancelled.
    cal.setPages([{ items: [timed("g1", "歯科（変更）", "2026-11-12T15:00:00+09:00", "2026-11-12T16:00:00+09:00"), { id: "rec_20261113", status: "cancelled" }], nextSyncToken: "sync-2" }]);
    const r = await call("POST", "/api/google/sync");
    expect(r.body).toMatchObject({ upserted: 1, deleted: 1, full: false });
    expect(cal.calls.at(-1)!.syncToken).toBe("sync-1");
    list = (await call("GET", RANGE)).body.events;
    expect(list.map((e: any) => e.title).sort()).toEqual(["歯科（変更）", "連休"]);
    expect(list.find((e: any) => e.title === "歯科（変更）").id).toBe(dentist.id);

    // Mirrored events cannot be edited or deleted here.
    expect((await call("PATCH", `/api/events/${dentist.id}`, { version: 2, title: "x" })).status).toBe(409);
    expect((await call("DELETE", `/api/events/${dentist.id}`)).status).toBe(409);
  });

  it("falls back to a full resync when the sync token expires, dropping events deleted meanwhile", async () => {
    const cal = fakeCalendar();
    cal.setPages([{ items: [timed("a", "残る", "2026-11-12T09:00:00Z", "2026-11-12T10:00:00Z"), timed("b", "消える", "2026-11-13T09:00:00Z", "2026-11-13T10:00:00Z")], nextSyncToken: "s1" }]);
    const { call } = await connect(cal);
    const keptId = (await call("GET", RANGE)).body.events.find((e: any) => e.title === "残る").id;

    cal.failOnce(new SyncTokenExpired("gone"));
    cal.setPages([{ items: [timed("a", "残る", "2026-11-12T09:00:00Z", "2026-11-12T10:00:00Z")], nextSyncToken: "s2" }]);
    const r = await call("POST", "/api/google/sync");
    expect(r.body).toMatchObject({ full: true, deleted: 1 });
    const list = (await call("GET", RANGE)).body.events;
    expect(list.map((e: any) => e.title)).toEqual(["残る"]);
    expect(list[0].id).toBe(keptId); // ids (and sharing settings) survive a resync
  });

  it("records a re-auth error when Google rejects the grant", async () => {
    const cal = fakeCalendar();
    const { call } = await connect(cal);
    cal.failOnce(new GoogleAuthError("revoked by user"));
    expect((await call("POST", "/api/google/sync")).status).toBe(502);
    expect((await call("GET", "/api/google")).body.last_error).toContain("連携し直して");
  });

  it("disconnects: revokes at Google and removes mirrored events", async () => {
    const cal = fakeCalendar();
    cal.setPages([{ items: [timed("a", "x", "2026-11-12T09:00:00Z", "2026-11-12T10:00:00Z")], nextSyncToken: "s1" }]);
    const { call } = await connect(cal);
    await call("POST", "/api/events", { title: "手入力", start_at: "2026-11-14T09:00:00Z", end_at: "2026-11-14T10:00:00Z" });
    const r = await call("DELETE", "/api/google");
    expect(r.body).toMatchObject({ disconnected: true, removed_events: 1 });
    expect(cal.revoked).toEqual(["refresh-SECRET"]);
    expect((await call("GET", RANGE)).body.events.map((e: any) => e.title)).toEqual(["手入力"]);
    expect((await call("GET", "/api/google")).body.connected).toBe(false);
  });
});

describe("secretbox", () => {
  it("round-trips and rejects tampering", async () => {
    const sealed = await seal("hello", env.GOOGLE_TOKEN_KEY);
    expect(await open(sealed, env.GOOGLE_TOKEN_KEY)).toBe("hello");
    const parts = sealed.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}AA`;
    await expect(open(tampered, env.GOOGLE_TOKEN_KEY)).rejects.toThrow();
  });
});
