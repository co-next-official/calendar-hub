import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/events";
import { eventReminders, events, pushSubscriptions, users } from "../src/db/schema";
import { dispatchReminders, type PushSender } from "../src/reminders/dispatch";
import { resetDb } from "./helpers";
import type { Env } from "../src/env";

beforeEach(resetDb);

const NOW = Date.parse("2027-03-01T00:00:00.000Z");
const db = () => getDb(env.DB);

async function mkUser(id: string, reminderDefaultMinutes: number | null = null) {
  await db().insert(users).values({ id, googleSub: `sub-${id}`, email: `${id}@example.com`, reminderDefaultMinutes });
}
async function mkEvent(id: string, ownerId: string, startAtMs: number) {
  await db().insert(events).values({
    id, ownerId, title: `Event ${id}`, allDay: false,
    startAt: new Date(startAtMs).toISOString(), endAt: new Date(startAtMs + 3_600_000).toISOString(),
  });
}
async function mkSub(id: string, userId: string, endpoint: string) {
  await db().insert(pushSubscriptions).values({ id, userId, endpoint, p256dh: "p", auth: "a" });
}

function recorder() {
  const calls: { endpoint: string; payload: string }[] = [];
  const send: PushSender = async (endpoint, _keys, payload) => {
    calls.push({ endpoint, payload });
    return { ok: true, status: 201, gone: false };
  };
  return { calls, send };
}

describe("dispatchReminders", () => {
  it("sends a reminder that is due via the user's default lead, once", async () => {
    await mkUser("u1", 30);
    await mkEvent("e1", "u1", NOW + 20 * 60000); // starts in 20 min; default lead 30 -> fireAt 10 min ago -> due
    await mkSub("s1", "u1", "https://push.test/s1");
    const { calls, send } = recorder();

    const r1 = await dispatchReminders(db(), env as Env, NOW, send);
    expect(r1).toMatchObject({ sent: 1, reminders: 1 });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.payload)).toMatchObject({ eventId: "e1", title: "Event e1" });

    // A materialized reminder row now marks it sent.
    const [row] = await db().select().from(eventReminders).where(eq(eventReminders.eventId, "e1"));
    expect(row?.sentAt).toBeTruthy();

    // Second tick does not resend.
    const r2 = await dispatchReminders(db(), env as Env, NOW + 60000, recorder().send);
    expect(r2.sent).toBe(0);
  });

  it("does not send when the event's reminder is explicitly disabled (override minutes = null)", async () => {
    await mkUser("u2", 30);
    await mkEvent("e2", "u2", NOW + 20 * 60000);
    await mkSub("s2", "u2", "https://push.test/s2");
    await db().insert(eventReminders).values({ id: "r2", eventId: "e2", minutesBefore: null });
    const { calls, send } = recorder();
    const r = await dispatchReminders(db(), env as Env, NOW, send);
    expect(r.sent).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("honors a per-event override lead over the user default", async () => {
    await mkUser("u3", null); // no default
    await mkEvent("e3", "u3", NOW + 5 * 60000); // in 5 min
    await mkSub("s3", "u3", "https://push.test/s3");
    await db().insert(eventReminders).values({ id: "r3", eventId: "e3", minutesBefore: 10 }); // fireAt 5 min ago -> due
    const { calls, send } = recorder();
    const r = await dispatchReminders(db(), env as Env, NOW, send);
    expect(r.sent).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("prunes subscriptions the push service reports as gone (404/410)", async () => {
    await mkUser("u4", 30);
    await mkEvent("e4", "u4", NOW + 20 * 60000);
    await mkSub("s4", "u4", "https://push.test/s4");
    const goneSender: PushSender = async () => ({ ok: false, status: 410, gone: true });
    const r = await dispatchReminders(db(), env as Env, NOW, goneSender);
    expect(r.pruned).toBe(1);
    const left = await db().select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, "u4"));
    expect(left).toHaveLength(0);
  });

  it("does nothing when the lead time has not arrived yet", async () => {
    await mkUser("u5", 10);
    await mkEvent("e5", "u5", NOW + 120 * 60000); // 2h away, lead 10 -> fireAt in ~110 min -> not due
    await mkSub("s5", "u5", "https://push.test/s5");
    const { calls, send } = recorder();
    const r = await dispatchReminders(db(), env as Env, NOW, send);
    expect(r.sent).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
