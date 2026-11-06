import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { getDb, getEvent } from "../db/events";
import { eventInvites, eventParticipants, events, groupMembers, users } from "../db/schema";
import { getVisibleEvent } from "../db/sharing";
import type { AppEnv } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { toIcs } from "./ics";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const RESPONSES = ["yes", "no", "maybe"] as const;
const MAX_PARTICIPANTS = 100;
const MAX_ACTIVE_INVITES = 10;

const sessionOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("auth").kind !== "session") return c.json({ error: "session_required" }, 403);
  await next();
};

/** Routes under /api/events/:id/... that deal with sharing. */
export function sharingRoutes() {
  const r = new Hono<AppEnv>();

  // Who can see the event. Owner only, browser session only (it exposes the event to other people).
  r.put("/:id/sharing", sessionOnly, async (c) => {
    const db = getDb(c.env.DB), me = c.get("user"), id = c.req.param("id");
    const event = await getEvent(db, me.id, id);
    if (!event) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "invalid_body" }, 400);

    const visibility = body.visibility;
    if (visibility !== "private" && visibility !== "participants" && visibility !== "group") return c.json({ error: "invalid_visibility" }, 400);
    const busyOnly = body.busy_only === undefined ? event.busyOnly : body.busy_only;
    if (typeof busyOnly !== "boolean") return c.json({ error: "invalid_busy_only" }, 400);

    let groupId: string | null = null;
    if (visibility === "group") {
      if (typeof body.group_id !== "string") return c.json({ error: "group_id_required" }, 400);
      const [m] = await db.select().from(groupMembers).where(and(eq(groupMembers.groupId, body.group_id), eq(groupMembers.userId, me.id), eq(groupMembers.status, "active"))).limit(1);
      if (!m) return c.json({ error: "group_not_found" }, 404);
      groupId = body.group_id;
    }

    const rawList = body.participants ?? [];
    if (!Array.isArray(rawList) || rawList.length > MAX_PARTICIPANTS) return c.json({ error: "invalid_participants" }, 400);
    const emails = [...new Set(rawList.map((e) => (typeof e === "string" ? e.trim().toLowerCase() : "")))];
    if (emails.some((e) => !EMAIL_RE.test(e))) return c.json({ error: "invalid_participant_email" }, 400);

    const existing = await db.select().from(eventParticipants).where(and(eq(eventParticipants.eventId, id)));
    const existingEmails = new Set(existing.filter((p) => p.email).map((p) => p.email!));
    const removed = existing.filter((p) => p.email && !emails.includes(p.email)).map((p) => p.id);
    const added = emails.filter((e) => !existingEmails.has(e) && e !== me.email.toLowerCase());

    const ops = [
      db.update(events).set({ visibility, groupId, busyOnly, updatedAt: new Date().toISOString() }).where(and(eq(events.id, id), eq(events.ownerId, me.id))),
      ...(removed.length ? [db.delete(eventParticipants).where(inArray(eventParticipants.id, removed))] : []),
      ...added.map((email) => db.insert(eventParticipants).values({ id: crypto.randomUUID(), eventId: id, email })),
    ];
    await db.batch(ops as [typeof ops[number], ...typeof ops]);
    return c.json(await getVisibleEvent(db, me, id));
  });

  // A participant answers (yes / no / maybe).
  r.post("/:id/response", async (c) => {
    const db = getDb(c.env.DB), me = c.get("user"), id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!RESPONSES.includes(body?.response as (typeof RESPONSES)[number])) return c.json({ error: "invalid_response" }, 400);
    if (!(await getVisibleEvent(db, me, id))) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .update(eventParticipants)
      .set({ response: body!.response as (typeof RESPONSES)[number], respondedAt: new Date().toISOString() })
      .where(and(eq(eventParticipants.eventId, id), eq(eventParticipants.email, me.email.toLowerCase())))
      .returning();
    if (!rows.length) return c.json({ error: "not_a_participant" }, 403);
    return c.json(await getVisibleEvent(db, me, id));
  });

  // Guest links (owner, session only).
  r.get("/:id/invites", sessionOnly, async (c) => {
    const db = getDb(c.env.DB), me = c.get("user"), id = c.req.param("id");
    if (!(await getEvent(db, me.id, id))) return c.json({ error: "not_found" }, 404);
    const rows = await db.select().from(eventInvites).where(eq(eventInvites.eventId, id)).orderBy(desc(eventInvites.createdAt));
    return c.json({ invites: rows.map((i) => ({ id: i.id, created_at: i.createdAt, expires_at: i.expiresAt, revoked_at: i.revokedAt })) });
  });

  r.post("/:id/invites", sessionOnly, async (c) => {
    const db = getDb(c.env.DB), me = c.get("user"), id = c.req.param("id");
    if (!(await getEvent(db, me.id, id))) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const days = body.expires_in_days ?? 14;
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 90) return c.json({ error: "invalid_expires_in_days" }, 400);
    const active = await db.select({ id: eventInvites.id }).from(eventInvites).where(and(eq(eventInvites.eventId, id), isNull(eventInvites.revokedAt)));
    if (active.length >= MAX_ACTIVE_INVITES) return c.json({ error: "too_many_invites" }, 400);
    const token = randomToken(24);
    const [row] = await db.insert(eventInvites).values({ id: crypto.randomUUID(), eventId: id, tokenHash: await sha256Hex(token), expiresAt: new Date(Date.now() + (days as number) * 86_400_000).toISOString() }).returning();
    // The token sits in the URL fragment so it is never sent to servers or leaked through Referer.
    return c.json({ id: row!.id, expires_at: row!.expiresAt, url: new URL(`/guest.html#${token}`, c.req.url).toString() }, 201);
  });

  r.delete("/:id/invites/:inviteId", sessionOnly, async (c) => {
    const db = getDb(c.env.DB), me = c.get("user"), id = c.req.param("id");
    if (!(await getEvent(db, me.id, id))) return c.json({ error: "not_found" }, 404);
    const rows = await db.update(eventInvites).set({ revokedAt: new Date().toISOString() }).where(and(eq(eventInvites.id, c.req.param("inviteId")), eq(eventInvites.eventId, id), isNull(eventInvites.revokedAt))).returning();
    return rows.length ? c.json({ revoked: true }) : c.json({ error: "not_found" }, 404);
  });

  // .ics for adding the event to another calendar app.
  r.get("/:id/ics", async (c) => {
    const db = getDb(c.env.DB), me = c.get("user");
    const e = await getVisibleEvent(db, me, c.req.param("id"));
    if (!e) return c.json({ error: "not_found" }, 404);
    return c.body(toIcs(e, new URL(c.req.url).host), 200, {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="event-${e.id}.ics"`,
    });
  });

  return r;
}

/** Public endpoints for guest links: no login, the link token is the only credential. */
export function guestRoutes() {
  const r = new Hono<AppEnv>();

  async function resolve(c: { env: AppEnv["Bindings"] }, token: string) {
    if (!token || token.length > 64) return null;
    const db = getDb(c.env.DB);
    const now = new Date().toISOString();
    const [row] = await db
      .select({ invite: eventInvites, event: events, ownerName: users.name, ownerEmail: users.email })
      .from(eventInvites)
      .innerJoin(events, eq(events.id, eventInvites.eventId))
      .innerJoin(users, eq(users.id, events.ownerId))
      .where(and(eq(eventInvites.tokenHash, await sha256Hex(token)), isNull(eventInvites.revokedAt)))
      .limit(1);
    if (!row || row.invite.expiresAt <= now) return null;
    return { db, ...row };
  }

  const view = async (found: NonNullable<Awaited<ReturnType<typeof resolve>>>) => {
    const parts = await found.db.select().from(eventParticipants).where(eq(eventParticipants.eventId, found.event.id));
    const e = found.event;
    return {
      title: e.title, notes: e.notes, all_day: e.allDay, start_date: e.startDate, end_date: e.endDate, start_at: e.startAt, end_at: e.endAt, timezone: e.timezone,
      host: found.ownerName || found.ownerEmail.split("@")[0],
      expires_at: found.invite.expiresAt,
      // Guests see first names and answers only, never email addresses.
      responses: parts.filter((p) => p.response !== "pending").map((p) => ({ name: p.guestName ?? "参加者", response: p.response })),
    };
  };

  r.get("/invites/:token", async (c) => {
    const found = await resolve(c, c.req.param("token"));
    return found ? c.json(await view(found)) : c.json({ error: "invalid_or_expired" }, 404);
  });

  r.post("/invites/:token/respond", async (c) => {
    const found = await resolve(c, c.req.param("token"));
    if (!found) return c.json({ error: "invalid_or_expired" }, 404);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 40) return c.json({ error: "invalid_name" }, 400);
    if (!RESPONSES.includes(body?.response as (typeof RESPONSES)[number])) return c.json({ error: "invalid_response" }, 400);
    const key = typeof body?.guest_key === "string" && /^[\w-]{20,64}$/.test(body.guest_key) ? body.guest_key : randomToken(24);
    const keyHash = await sha256Hex(key);
    const response = body!.response as (typeof RESPONSES)[number];
    const now = new Date().toISOString();
    const [existing] = await found.db.select({ id: eventParticipants.id }).from(eventParticipants).where(and(eq(eventParticipants.eventId, found.event.id), eq(eventParticipants.guestKeyHash, keyHash))).limit(1);
    if (existing) {
      await found.db.update(eventParticipants).set({ guestName: name, response, respondedAt: now }).where(eq(eventParticipants.id, existing.id));
    } else {
      const count = await found.db.select({ id: eventParticipants.id }).from(eventParticipants).where(eq(eventParticipants.eventId, found.event.id));
      if (count.length >= MAX_PARTICIPANTS * 2) return c.json({ error: "too_many_responses" }, 400);
      await found.db.insert(eventParticipants).values({ id: crypto.randomUUID(), eventId: found.event.id, guestName: name, guestKeyHash: keyHash, inviteId: found.invite.id, response, respondedAt: now });
    }
    return c.json({ ...(await view(found)), guest_key: key });
  });

  return r;
}
