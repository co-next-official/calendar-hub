// Read access for shared events. Writes stay owner-only and go through ./events.ts.
import { and, asc, eq, gt, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "./events";
import { toApi } from "./events";
import { eventParticipants, events, users, type EventRow, type User } from "./schema";

const HOUR_MS = 3_600_000;

/** True when `me` may see the event at all: owner, active member of its group, or listed participant. */
export function canSee(me: Pick<User, "id" | "email">): SQL {
  const email = me.email.toLowerCase();
  return or(
    eq(events.ownerId, me.id),
    sql`(${events.visibility} = 'group' and ${events.groupId} in (select group_id from group_members where user_id = ${me.id} and status = 'active'))`,
    sql`(${events.visibility} = 'participants' and ${events.id} in (select event_id from event_participants where email = ${email}))`,
  )!;
}

type Joined = { event: EventRow; ownerName: string; ownerEmail: string };

export async function listVisibleEvents(db: Db, me: User, range: { from: string; to: string; q?: string }) {
  const padFrom = new Date(Date.parse(`${range.from}T00:00:00Z`) - 14 * HOUR_MS).toISOString();
  const padTo = new Date(Date.parse(`${range.to}T00:00:00Z`) + 14 * HOUR_MS).toISOString();
  const filters: SQL[] = [
    canSee(me),
    or(
      and(isNotNull(events.startDate), lt(events.startDate, range.to), gt(events.endDate, range.from)),
      and(isNotNull(events.startAt), lt(events.startAt, padTo), gt(events.endAt, padFrom)),
    )!,
  ];
  // Search never matches hidden titles of busy-only events shared with me.
  if (range.q) filters.push(sql`instr(lower(${events.title}), lower(${range.q})) > 0 and (${events.ownerId} = ${me.id} or ${events.busyOnly} = 0)`);
  const rows = await db
    .select({ event: events, ownerName: users.name, ownerEmail: users.email })
    .from(events)
    .innerJoin(users, eq(users.id, events.ownerId))
    .where(and(...filters))
    .orderBy(asc(sql`coalesce(${events.startDate}, ${events.startAt})`))
    .limit(2000);
  return withParticipants(db, me, rows);
}

export async function getVisibleEvent(db: Db, me: User, id: string) {
  const rows = await db
    .select({ event: events, ownerName: users.name, ownerEmail: users.email })
    .from(events)
    .innerJoin(users, eq(users.id, events.ownerId))
    .where(and(eq(events.id, id), canSee(me)))
    .limit(1);
  return (await withParticipants(db, me, rows))[0] ?? null;
}

async function withParticipants(db: Db, me: User, rows: Joined[]) {
  const ids = rows.map((r) => r.event.id);
  const parts = ids.length ? await db.select().from(eventParticipants).where(inArray(eventParticipants.eventId, ids)) : [];
  return rows.map((r) => presentEvent(r, me, parts.filter((p) => p.eventId === r.event.id)));
}

type ParticipantRow = typeof eventParticipants.$inferSelect;

/**
 * Shapes an event for a viewer. The owner sees everything. Others see owner name, and
 * - busy_only: only the time slot ("予定あり"), no title/notes/participants
 * - otherwise: title, notes, participants and their responses
 */
export function presentEvent(r: Joined, me: User, parts: ParticipantRow[]) {
  const isOwner = r.event.ownerId === me.id;
  const myRow = parts.find((p) => p.email === me.email.toLowerCase());
  const base = toApi(r.event);
  const participants = parts.map((p) => ({ id: p.id, email: p.email, name: p.guestName, guest: p.email === null, response: p.response }));
  if (isOwner) return { ...base, group_id: r.event.groupId, is_owner: true, owner_name: r.ownerName, participants };
  const shared = { ...base, is_owner: false, owner_name: r.ownerName || r.ownerEmail, my_response: myRow?.response ?? null, group_id: r.event.groupId };
  if (r.event.busyOnly) return { ...shared, title: "予定あり", notes: "", participants: [], source: "web" as const, category: "personal" as const };
  return { ...shared, participants };
}
