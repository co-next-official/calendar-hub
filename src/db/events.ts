// Every query here takes ownerId and filters on it. Route handlers never touch the events table directly.
import { and, asc, eq, gt, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { EventFields } from "../events/validate";
import { events, type EventRow } from "./schema";

export type Db = ReturnType<typeof drizzle>;
export const getDb = (d1: D1Database): Db => drizzle(d1);

const HOUR_MS = 3_600_000;

/** Events overlapping [from, to) where from/to are dates. Timed events are padded by 14h to cover every timezone. */
export async function listEvents(db: Db, ownerId: string, range: { from: string; to: string; q?: string }) {
  const padFrom = new Date(Date.parse(`${range.from}T00:00:00Z`) - 14 * HOUR_MS).toISOString();
  const padTo = new Date(Date.parse(`${range.to}T00:00:00Z`) + 14 * HOUR_MS).toISOString();
  const overlaps = or(
    and(isNotNull(events.startDate), lt(events.startDate, range.to), gt(events.endDate, range.from)),
    and(isNotNull(events.startAt), lt(events.startAt, padTo), gt(events.endAt, padFrom)),
  )!;
  const filters: SQL[] = [eq(events.ownerId, ownerId), overlaps];
  if (range.q) filters.push(sql`instr(lower(${events.title}), lower(${range.q})) > 0`);
  return db
    .select()
    .from(events)
    .where(and(...filters))
    .orderBy(asc(sql`coalesce(${events.startDate}, ${events.startAt})`))
    .limit(2000);
}

export async function getEvent(db: Db, ownerId: string, id: string) {
  const [row] = await db.select().from(events).where(and(eq(events.id, id), eq(events.ownerId, ownerId))).limit(1);
  return row ?? null;
}

export async function findByLegacyId(db: Db, ownerId: string, legacyId: string) {
  const [row] = await db.select().from(events).where(and(eq(events.ownerId, ownerId), eq(events.legacyId, legacyId))).limit(1);
  return row ?? null;
}

export async function createEvent(
  db: Db,
  ownerId: string,
  fields: EventFields,
  meta: { source: EventRow["source"]; legacyId?: string | null },
) {
  const [row] = await db
    .insert(events)
    .values({ id: crypto.randomUUID(), ownerId, ...fields, source: meta.source, legacyId: meta.legacyId ?? null })
    .returning();
  return row!;
}

export type UpdateResult = { status: "ok"; row: EventRow } | { status: "not_found" } | { status: "conflict"; row: EventRow };

/** Optimistic concurrency: the update only applies if `version` still matches. */
export async function updateEvent(db: Db, ownerId: string, id: string, version: number, fields: EventFields): Promise<UpdateResult> {
  const [row] = await db
    .update(events)
    .set({ ...fields, version: sql`${events.version} + 1`, updatedAt: new Date().toISOString() })
    .where(and(eq(events.id, id), eq(events.ownerId, ownerId), eq(events.version, version)))
    .returning();
  if (row) return { status: "ok", row };
  const current = await getEvent(db, ownerId, id);
  return current ? { status: "conflict", row: current } : { status: "not_found" };
}

export async function deleteEvent(db: Db, ownerId: string, id: string) {
  const rows = await db.delete(events).where(and(eq(events.id, id), eq(events.ownerId, ownerId))).returning({ id: events.id });
  return rows.length > 0;
}

export function toFields(row: EventRow): EventFields {
  return {
    title: row.title, notes: row.notes, category: row.category, allDay: row.allDay,
    startDate: row.startDate, endDate: row.endDate, startAt: row.startAt, endAt: row.endAt, timezone: row.timezone,
  };
}

/** API representation (snake_case). owner_id and legacy_id stay server-side. */
export function toApi(row: EventRow) {
  return {
    id: row.id, title: row.title, notes: row.notes, category: row.category, all_day: row.allDay,
    start_date: row.startDate, end_date: row.endDate, start_at: row.startAt, end_at: row.endAt,
    timezone: row.timezone, visibility: row.visibility, busy_only: row.busyOnly, source: row.source,
    version: row.version, created_at: row.createdAt, updated_at: row.updatedAt,
  };
}
