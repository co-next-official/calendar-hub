import { Hono } from "hono";
import { createEvent, deleteEvent, findByLegacyId, getDb, getEvent, toFields, updateEvent } from "../db/events";
import { getVisibleEvent, listVisibleEvents } from "../db/sharing";
import { and, eq, gt, isNotNull, lt, ne } from "drizzle-orm";
import type { Db } from "../db/events";
import { events, type EventRow } from "../db/schema";
import type { AppEnv } from "../env";
import { convertLegacyEvent } from "./legacy";
import { isDate, isTimeZone, validateEvent } from "./validate";

const MAX_RANGE_DAYS = 400;
const LEGACY_ID_RE = /^[\w-]{1,80}$/;

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The owner's other timed events that overlap a timed event (for a "double booking" warning). */
async function ownConflicts(db: Db, ownerId: string, row: EventRow) {
  if (row.allDay || !row.startAt || !row.endAt) return [];
  const rows = await db
    .select({ id: events.id, title: events.title, start_at: events.startAt, end_at: events.endAt })
    .from(events)
    .where(and(eq(events.ownerId, ownerId), ne(events.id, row.id), isNotNull(events.startAt), lt(events.startAt, row.endAt), gt(events.endAt, row.startAt)))
    .limit(10);
  return rows;
}

export function eventRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    const from = c.req.query("from"), to = c.req.query("to"), q = c.req.query("q")?.trim() || undefined;
    if (!isDate(from) || !isDate(to) || from >= to) return c.json({ error: "from_and_to_required" }, 400);
    if (Date.parse(to) - Date.parse(from) > MAX_RANGE_DAYS * 86_400_000) return c.json({ error: "range_too_long" }, 400);
    if (q && q.length > 120) return c.json({ error: "invalid_q" }, 400);
    return c.json({ events: await listVisibleEvents(getDb(c.env.DB), c.get("user"), { from, to, q }) });
  });

  r.post("/", async (c) => {
    const body = await readBody(c.req.raw);
    if (!body) return c.json({ error: "invalid_body" }, 400);
    const result = validateEvent(body);
    if (!result.ok) return c.json({ error: result.error }, 400);
    const db = getDb(c.env.DB);
    const row = await createEvent(db, c.get("user").id, result.value, { source: c.get("auth").kind === "token" ? "api" : "web" });
    return c.json({ ...(await getVisibleEvent(db, c.get("user"), row.id)), conflicts: await ownConflicts(db, c.get("user").id, row) }, 201);
  });

  r.get("/:id", async (c) => {
    const row = await getVisibleEvent(getDb(c.env.DB), c.get("user"), c.req.param("id"));
    return row ? c.json(row) : c.json({ error: "not_found" }, 404);
  });

  r.patch("/:id", async (c) => {
    const body = await readBody(c.req.raw);
    if (!body) return c.json({ error: "invalid_body" }, 400);
    if (!Number.isInteger(body.version)) return c.json({ error: "version_required" }, 400);
    const db = getDb(c.env.DB), ownerId = c.get("user").id, id = c.req.param("id");
    const current = await getEvent(db, ownerId, id);
    if (!current) return c.json({ error: "not_found" }, 404);
    const result = validateEvent(body, toFields(current));
    if (!result.ok) return c.json({ error: result.error }, 400);
    const updated = await updateEvent(db, ownerId, id, body.version as number, result.value);
    if (updated.status === "not_found") return c.json({ error: "not_found" }, 404);
    if (updated.status === "conflict") return c.json({ error: "version_conflict", current: await getVisibleEvent(db, c.get("user"), id) }, 409);
    return c.json({ ...(await getVisibleEvent(db, c.get("user"), id)), conflicts: await ownConflicts(db, c.get("user").id, updated.row) });
  });

  r.delete("/:id", async (c) => {
    // Destructive calls from an API key (i.e. an AI) must be explicitly confirmed.
    if (c.get("auth").kind === "token" && c.req.query("confirm") !== "true") {
      return c.json({ error: "confirmation_required", hint: "Ask the user, then retry with ?confirm=true" }, 428);
    }
    const ok = await deleteEvent(getDb(c.env.DB), c.get("user").id, c.req.param("id"));
    return ok ? c.json({ deleted: true }) : c.json({ error: "not_found" }, 404);
  });

  return r;
}

/** Imports events exported from the old ChatGPT Sites Calendar Hub (`GET /api/events` there). Idempotent per old id. */
export function importRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/calendar-hub", async (c) => {
    const body = await readBody(c.req.raw);
    const list = body?.events;
    if (!Array.isArray(list) || list.length > 5000) return c.json({ error: "events_array_required" }, 400);
    const timezone = body?.timezone ?? "Asia/Tokyo";
    if (!isTimeZone(timezone)) return c.json({ error: "invalid_timezone" }, 400);

    const db = getDb(c.env.DB), ownerId = c.get("user").id;
    let created = 0, skipped = 0;
    const failed: { index: number; error: string }[] = [];
    for (const [index, item] of list.entries()) {
      const legacyId = item && typeof item === "object" && typeof item.id === "string" && LEGACY_ID_RE.test(item.id) ? item.id : null;
      if (legacyId && (await findByLegacyId(db, ownerId, legacyId))) { skipped++; continue; }
      const converted = convertLegacyEvent(item, timezone);
      if (!converted.ok) { failed.push({ index, error: converted.error }); continue; }
      await createEvent(db, ownerId, converted.value, { source: "import", legacyId });
      created++;
    }
    return c.json({ created, skipped, failed });
  });

  return r;
}
