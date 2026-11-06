import { beforeEach, describe, expect, it } from "vitest";
import { login, resetDb, testApp } from "./helpers";

beforeEach(resetDb);

type Res = { status: number; body: Record<string, any>; text: string };

async function setup() {
  const t = testApp();
  const as = async (sub: string, email: string) => {
    const { cookie } = await login(t, { sub, email, name: sub.toUpperCase() });
    return async (method: string, path: string, body?: unknown): Promise<Res> => {
      const res = await t.request(path, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let parsed: Record<string, any> = {};
      try { parsed = JSON.parse(text); } catch { /* ics */ }
      return { status: res.status, body: parsed, text };
    };
  };
  const guest = async (method: string, path: string, body?: unknown) => {
    const res = await t.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { as, guest };
}

const RANGE = "/api/events?from=2026-11-01&to=2026-12-01";
const secret = { title: "通院（内科）", notes: "結果を聞く", start_at: "2026-11-10T10:00:00+09:00", end_at: "2026-11-10T11:00:00+09:00" };

describe("sharing with participants", () => {
  it("shows the event only to listed participants and lets them answer", async () => {
    const { as } = await setup();
    const alice = await as("a", "alice@example.com"), bob = await as("b", "bob@example.com"), carol = await as("c", "carol@example.com");
    const { body: e } = await alice("POST", "/api/events", secret);

    expect((await bob("GET", RANGE)).body.events).toEqual([]);
    const shared = await alice("PUT", `/api/events/${e.id}/sharing`, { visibility: "participants", participants: ["Bob@Example.com"] });
    expect(shared.body.participants).toMatchObject([{ email: "bob@example.com", response: "pending" }]);

    const seen = (await bob("GET", RANGE)).body.events;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ title: "通院（内科）", is_owner: false, owner_name: "A", my_response: "pending" });
    expect((await carol("GET", RANGE)).body.events).toEqual([]);
    expect((await carol("GET", `/api/events/${e.id}`)).status).toBe(404);

    expect((await bob("POST", `/api/events/${e.id}/response`, { response: "yes" })).body.my_response).toBe("yes");
    expect((await alice("GET", `/api/events/${e.id}`)).body.participants[0].response).toBe("yes");
    expect((await carol("POST", `/api/events/${e.id}/response`, { response: "yes" })).status).toBe(404);

    // Viewers cannot edit, delete or reshare.
    expect((await bob("PATCH", `/api/events/${e.id}`, { version: 1, title: "x" })).status).toBe(404);
    expect((await bob("DELETE", `/api/events/${e.id}`)).status).toBe(404);
    expect((await bob("PUT", `/api/events/${e.id}/sharing`, { visibility: "private" })).status).toBe(404);

    // Removing a participant revokes access.
    await alice("PUT", `/api/events/${e.id}/sharing`, { visibility: "participants", participants: [] });
    expect((await bob("GET", RANGE)).body.events).toEqual([]);
  });
});

describe("sharing with a group and busy-only", () => {
  it("shares to active group members, and busy_only hides every detail", async () => {
    const { as } = await setup();
    const alice = await as("a", "alice@example.com"), bob = await as("b", "bob@example.com"), dave = await as("d", "dave@example.com");
    const { body: g } = await alice("POST", "/api/groups", { name: "家族" });
    await alice("POST", `/api/groups/${g.id}/members`, { email: "bob@example.com" });
    await alice("POST", `/api/groups/${g.id}/members`, { email: "dave@example.com" }); // dave never accepts
    await bob("POST", `/api/groups/${g.id}/accept`);

    const { body: e } = await alice("POST", "/api/events", secret);
    expect((await alice("PUT", `/api/events/${e.id}/sharing`, { visibility: "group", group_id: g.id, busy_only: true })).status).toBe(200);

    const list = await bob("GET", RANGE);
    expect(list.body.events).toHaveLength(1);
    expect(list.body.events[0]).toMatchObject({ title: "予定あり", notes: "", participants: [] });
    expect(list.text).not.toContain("通院");
    expect(list.text).not.toContain("結果を聞く");
    expect((await bob("GET", `/api/events/${e.id}`)).text).not.toContain("通院");
    expect((await bob("GET", `/api/events/${e.id}/ics`)).text).not.toContain("通院");
    // Searching for the hidden title must not reveal that it matches.
    expect((await bob("GET", `${RANGE}&q=${encodeURIComponent("通院")}`)).body.events).toEqual([]);
    // Invited-but-not-accepted members see nothing.
    expect((await dave("GET", RANGE)).body.events).toEqual([]);

    await alice("PUT", `/api/events/${e.id}/sharing`, { visibility: "group", group_id: g.id, busy_only: false });
    expect((await bob("GET", RANGE)).body.events[0].title).toBe("通院（内科）");
  });

  it("refuses to share to a group the owner is not in", async () => {
    const { as } = await setup();
    const alice = await as("a", "alice@example.com"), bob = await as("b", "bob@example.com");
    const { body: g } = await bob("POST", "/api/groups", { name: "bob's" });
    const { body: e } = await alice("POST", "/api/events", secret);
    expect((await alice("PUT", `/api/events/${e.id}/sharing`, { visibility: "group", group_id: g.id })).status).toBe(404);
  });
});

describe("guest links", () => {
  it("lets anyone with a valid link view and answer, until it is revoked", async () => {
    const { as, guest } = await setup();
    const alice = await as("a", "alice@example.com");
    const { body: e } = await alice("POST", "/api/events", secret);
    const { body: link } = await alice("POST", `/api/events/${e.id}/invites`, { expires_in_days: 7 });
    const token = new URL(link.url).hash.slice(1);
    expect(link.url).toContain("/guest.html#");

    const view = await guest("GET", `/guest/api/invites/${token}`);
    expect(view.body).toMatchObject({ title: "通院（内科）", host: "A" });
    expect(JSON.stringify(view.body)).not.toContain("alice@example.com");

    const first = await guest("POST", `/guest/api/invites/${token}/respond`, { name: "おばあちゃん", response: "maybe" });
    expect(first.body.responses).toEqual([{ name: "おばあちゃん", response: "maybe" }]);
    const again = await guest("POST", `/guest/api/invites/${token}/respond`, { name: "おばあちゃん", response: "yes", guest_key: first.body.guest_key });
    expect(again.body.responses).toEqual([{ name: "おばあちゃん", response: "yes" }]);
    expect((await alice("GET", `/api/events/${e.id}`)).body.participants).toMatchObject([{ name: "おばあちゃん", guest: true, response: "yes" }]);

    expect((await guest("GET", "/guest/api/invites/not-a-real-token")).status).toBe(404);
    await alice("DELETE", `/api/events/${e.id}/invites/${link.id}`);
    expect((await guest("GET", `/guest/api/invites/${token}`)).status).toBe(404);
  });

  it("only the owner can create links", async () => {
    const { as } = await setup();
    const alice = await as("a", "alice@example.com"), bob = await as("b", "bob@example.com");
    const { body: e } = await alice("POST", "/api/events", secret);
    await alice("PUT", `/api/events/${e.id}/sharing`, { visibility: "participants", participants: ["bob@example.com"] });
    expect((await bob("POST", `/api/events/${e.id}/invites`, {})).status).toBe(404);
  });
});

describe("ics export", () => {
  it("exports a valid VEVENT", async () => {
    const { as } = await setup();
    const alice = await as("a", "alice@example.com");
    const { body: e } = await alice("POST", "/api/events", { ...secret, notes: "改行\nあり, カンマ" });
    const ics = (await alice("GET", `/api/events/${e.id}/ics`)).text;
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("DTSTART:20261110T010000Z");
    expect(ics).toContain("DESCRIPTION:改行\\nあり\\, カンマ");
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });
});
