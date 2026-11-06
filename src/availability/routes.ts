import { and, eq, gt, inArray, isNotNull, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/events";
import { events, groupMembers } from "../db/schema";
import type { AppEnv } from "../env";
import { isDate, isTimeZone } from "../events/validate";
import { allDayToInterval, findFreeWindows, type Interval } from "./find";

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const MAX_DAYS = 31;

/**
 * GET /api/availability?group_id=&from=&to=&duration=&day_start=&day_end=&timezone=&include_all_day=
 * Returns only merged free windows. Members' events, titles and individual busy times are never returned.
 * Uses every event of every active member (membership acceptance is the consent for this).
 */
export function availabilityRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    const q = (k: string) => c.req.query(k);
    const from = q("from"), to = q("to");
    const durationMin = Number(q("duration") ?? 60);
    const dayStart = q("day_start") ?? "09:00", dayEnd = q("day_end") ?? "21:00";
    const timeZone = q("timezone") ?? "Asia/Tokyo";
    const includeAllDay = q("include_all_day") === "true";
    if (!isDate(from) || !isDate(to) || from >= to) return c.json({ error: "from_and_to_required" }, 400);
    if (Date.parse(to) - Date.parse(from) > MAX_DAYS * 86_400_000) return c.json({ error: "range_too_long" }, 400);
    if (!Number.isInteger(durationMin) || durationMin < 15 || durationMin > 720) return c.json({ error: "invalid_duration" }, 400);
    if (!TIME_RE.test(dayStart) || !TIME_RE.test(dayEnd) || dayStart >= dayEnd) return c.json({ error: "invalid_day_window" }, 400);
    if (!isTimeZone(timeZone)) return c.json({ error: "invalid_timezone" }, 400);

    const db = getDb(c.env.DB), me = c.get("user");
    let memberIds = [me.id];
    const groupId = q("group_id");
    if (groupId) {
      const members = await db.select({ userId: groupMembers.userId }).from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, "active")));
      const ids = members.map((m) => m.userId).filter((x): x is string => Boolean(x));
      if (!ids.includes(me.id)) return c.json({ error: "group_not_found" }, 404);
      memberIds = ids;
    }

    const padFrom = new Date(Date.parse(`${from}T00:00:00Z`) - 14 * 3_600_000).toISOString();
    const padTo = new Date(Date.parse(`${to}T00:00:00Z`) + 14 * 3_600_000).toISOString();
    const rows = await db
      .select({ allDay: events.allDay, startDate: events.startDate, endDate: events.endDate, startAt: events.startAt, endAt: events.endAt })
      .from(events)
      .where(and(
        inArray(events.ownerId, memberIds),
        or(
          and(isNotNull(events.startAt), lt(events.startAt, padTo), gt(events.endAt, padFrom)),
          includeAllDay ? and(isNotNull(events.startDate), lt(events.startDate, to), gt(events.endDate, from)) : undefined,
        ),
      ));
    const busy: Interval[] = rows.map((e) =>
      e.allDay ? allDayToInterval(e.startDate!, e.endDate!, timeZone) : { start: Date.parse(e.startAt!), end: Date.parse(e.endAt!) },
    );
    const windows = findFreeWindows(busy, { from, to, dayStart: dayStart === "24:00" ? "23:59" : dayStart, dayEnd: dayEnd === "24:00" ? "23:59" : dayEnd, durationMin, timeZone, notBefore: Date.now(), limit: 100 });
    return c.json({
      members: memberIds.length,
      duration_minutes: durationMin,
      windows: windows.map((w) => ({ start_at: new Date(w.start).toISOString(), end_at: new Date(w.end).toISOString() })),
    });
  });

  return r;
}
