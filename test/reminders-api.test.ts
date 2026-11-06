import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/events";
import { eventReminders, pushSubscriptions } from "../src/db/schema";
import { login, resetDb, testApp } from "./helpers";

beforeEach(resetDb);

async function session(sub: string, email: string) {
  const t = testApp();
  const { cookie } = await login(t, { sub, email });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await t.request(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  };
  return { t, call };
}

describe("/api/reminders", () => {
  it("rejects requests without a session", async () => {
    const t = testApp();
    const res = await t.request("/api/reminders/settings");
    expect(res.status).toBe(401); // requireUser runs before the route's session guard
  });

  it("gets and updates the user's default reminder lead, with validation", async () => {
    const { call } = await session("u1", "u1@example.com");
    expect((await call("GET", "/api/reminders/settings")).body).toEqual({ defaultMinutes: null });

    expect((await call("PUT", "/api/reminders/settings", { defaultMinutes: 30 })).body).toEqual({ defaultMinutes: 30 });
    expect((await call("GET", "/api/reminders/settings")).body).toEqual({ defaultMinutes: 30 });

    expect((await call("PUT", "/api/reminders/settings", { defaultMinutes: -1 })).status).toBe(400);
    expect((await call("PUT", "/api/reminders/settings", { defaultMinutes: 1.5 })).status).toBe(400);
    expect((await call("PUT", "/api/reminders/settings", { defaultMinutes: 999999 })).status).toBe(400);
    expect((await call("PUT", "/api/reminders/settings", { defaultMinutes: null })).body).toEqual({ defaultMinutes: null });
  });

  it("exposes the VAPID public key (null when unset in tests)", async () => {
    const { call } = await session("u2", "u2@example.com");
    expect((await call("GET", "/api/reminders/vapid-public-key")).body).toEqual({ key: null });
  });

  it("registers and removes a push subscription (https only, upsert by endpoint)", async () => {
    const { call } = await session("u3", "u3@example.com");
    expect((await call("POST", "/api/reminders/subscriptions", { endpoint: "http://insecure/x", p256dh: "k", auth: "a" })).status).toBe(400);
    expect((await call("POST", "/api/reminders/subscriptions", { endpoint: "https://push.test/e1", p256dh: "k", auth: "a" })).status).toBe(201);
    // Upsert: same endpoint again does not duplicate.
    expect((await call("POST", "/api/reminders/subscriptions", { endpoint: "https://push.test/e1", p256dh: "k2", auth: "a2" })).status).toBe(201);
    const rows = await getDb(env.DB).select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p256dh).toBe("k2");

    expect((await call("DELETE", "/api/reminders/subscriptions", { endpoint: "https://push.test/e1" })).status).toBe(200);
    expect((await call("DELETE", "/api/reminders/subscriptions", { endpoint: "https://push.test/e1" })).status).toBe(404);
  });

  it("sets and clears a per-event reminder override, and refuses events you do not own", async () => {
    const { call } = await session("owner", "owner@example.com");
    const created = await call("POST", "/api/events", {
      title: "Standup",
      start_at: "2027-03-01T00:00:00.000Z", end_at: "2027-03-01T00:30:00.000Z",
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    expect((await call("PUT", `/api/reminders/events/${id}`, { minutesBefore: 15 })).body).toEqual({ minutesBefore: 15 });
    let [row] = await getDb(env.DB).select().from(eventReminders).where(eq(eventReminders.eventId, id));
    expect(row?.minutesBefore).toBe(15);

    // null disables; sentAt is reset so a changed reminder can fire again.
    expect((await call("PUT", `/api/reminders/events/${id}`, { minutesBefore: null })).body).toEqual({ minutesBefore: null });
    [row] = await getDb(env.DB).select().from(eventReminders).where(eq(eventReminders.eventId, id));
    expect(row?.minutesBefore).toBeNull();

    expect((await call("DELETE", `/api/reminders/events/${id}`)).status).toBe(200);
    const after = await getDb(env.DB).select().from(eventReminders).where(eq(eventReminders.eventId, id));
    expect(after).toHaveLength(0);

    // A different user cannot touch this event's reminder.
    const other = await session("intruder", "intruder@example.com");
    expect((await other.call("PUT", `/api/reminders/events/${id}`, { minutesBefore: 10 })).status).toBe(404);
    expect((await other.call("DELETE", `/api/reminders/events/${id}`)).status).toBe(404);
  });
});
