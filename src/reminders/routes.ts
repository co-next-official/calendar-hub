import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/events";
import { eventReminders, events, pushSubscriptions, users } from "../db/schema";
import type { AppEnv } from "../env";

const MAX_MINUTES = 40320;

function validMinutes(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_MINUTES);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** /api/reminders — Web Push subscriptions and reminder settings (browser session only). */
export function reminderRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    if (c.get("auth").kind !== "session") return c.json({ error: "session_required" }, 403);
    await next();
  });

  r.get("/vapid-public-key", (c) => c.json({ key: c.env.VAPID_PUBLIC_KEY || null }));

  r.get("/settings", (c) => c.json({ defaultMinutes: c.get("user").reminderDefaultMinutes ?? null }));

  r.put("/settings", async (c) => {
    const body = await c.req.json().catch(() => null);
    const defaultMinutes = body?.defaultMinutes;
    if (!validMinutes(defaultMinutes)) return c.json({ error: "invalid" }, 400);
    await getDb(c.env.DB).update(users).set({ reminderDefaultMinutes: defaultMinutes }).where(eq(users.id, c.get("user").id));
    return c.json({ defaultMinutes });
  });

  r.post("/subscriptions", async (c) => {
    const body = await c.req.json().catch(() => null);
    const endpoint = body?.endpoint, p256dh = body?.p256dh, auth = body?.auth;
    if (!nonEmptyString(endpoint) || !nonEmptyString(p256dh) || !nonEmptyString(auth)) return c.json({ error: "invalid" }, 400);
    let url: URL;
    try { url = new URL(endpoint); } catch { return c.json({ error: "invalid" }, 400); }
    if (url.protocol !== "https:") return c.json({ error: "invalid" }, 400);
    const userId = c.get("user").id;
    await getDb(c.env.DB).insert(pushSubscriptions).values({ id: crypto.randomUUID(), userId, endpoint, p256dh, auth }).onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId, p256dh, auth, failureCount: 0 } });
    return c.json({ ok: true }, 201);
  });

  r.delete("/subscriptions", async (c) => {
    const body = await c.req.json().catch(() => null);
    const endpoint = body?.endpoint;
    if (!nonEmptyString(endpoint)) return c.json({ error: "invalid" }, 400);
    const rows = await getDb(c.env.DB).delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, c.get("user").id))).returning();
    if (!rows.length) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  r.get("/events/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDb(c.env.DB);
    const [owned] = await db.select().from(events).where(and(eq(events.id, id), eq(events.ownerId, c.get("user").id))).limit(1);
    if (!owned) return c.json({ error: "not_found" }, 404);
    const [row] = await db.select().from(eventReminders).where(eq(eventReminders.eventId, id)).limit(1);
    return c.json({ hasOverride: !!row, minutesBefore: row ? row.minutesBefore : null });
  });

  r.put("/events/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const minutesBefore = body?.minutesBefore;
    if (!validMinutes(minutesBefore)) return c.json({ error: "invalid" }, 400);
    const db = getDb(c.env.DB);
    const [owned] = await db.select().from(events).where(and(eq(events.id, id), eq(events.ownerId, c.get("user").id))).limit(1);
    if (!owned) return c.json({ error: "not_found" }, 404);
    await db.insert(eventReminders).values({ id: crypto.randomUUID(), eventId: id, minutesBefore, sentAt: null }).onConflictDoUpdate({ target: eventReminders.eventId, set: { minutesBefore, sentAt: null } });
    return c.json({ minutesBefore });
  });

  r.delete("/events/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDb(c.env.DB);
    const [owned] = await db.select().from(events).where(and(eq(events.id, id), eq(events.ownerId, c.get("user").id))).limit(1);
    if (!owned) return c.json({ error: "not_found" }, 404);
    await db.delete(eventReminders).where(eq(eventReminders.eventId, id));
    return c.json({ ok: true });
  });

  return r;
}
