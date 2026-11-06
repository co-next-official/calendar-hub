import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/events";
import { calendarFeeds, users } from "../db/schema";
import { listVisibleEvents } from "../db/sharing";
import type { AppEnv } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { addDays } from "./validate";
import { toIcsCalendar } from "./ics";

const PAST_DAYS = 60;
const FUTURE_DAYS = 400;

/** /api/feed — manage the secret subscription URL (browser session only). */
export function feedApiRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    if (c.get("auth").kind !== "session") return c.json({ error: "session_required" }, 403);
    await next();
  });

  r.get("/", async (c) => {
    const [feed] = await getDb(c.env.DB).select().from(calendarFeeds).where(and(eq(calendarFeeds.userId, c.get("user").id), isNull(calendarFeeds.revokedAt))).limit(1);
    return c.json(feed ? { active: true, created_at: feed.createdAt, last_fetched_at: feed.lastFetchedAt } : { active: false });
  });

  // Creates a new URL and revokes any previous one. The URL is shown once.
  r.post("/", async (c) => {
    const db = getDb(c.env.DB), userId = c.get("user").id, now = new Date().toISOString();
    const token = randomToken(32);
    await db.batch([
      db.update(calendarFeeds).set({ revokedAt: now }).where(and(eq(calendarFeeds.userId, userId), isNull(calendarFeeds.revokedAt))),
      db.insert(calendarFeeds).values({ id: crypto.randomUUID(), userId, tokenHash: await sha256Hex(token) }),
    ]);
    const url = new URL(`/feed/${token}.ics`, c.req.url);
    return c.json({ url: url.toString(), webcal_url: url.toString().replace(/^https?:/, "webcal:") }, 201);
  });

  r.delete("/", async (c) => {
    const rows = await getDb(c.env.DB).update(calendarFeeds).set({ revokedAt: new Date().toISOString() }).where(and(eq(calendarFeeds.userId, c.get("user").id), isNull(calendarFeeds.revokedAt))).returning();
    return rows.length ? c.json({ revoked: true }) : c.json({ error: "not_found" }, 404);
  });

  return r;
}

/** /feed/:token.ics — public, the token is the credential. Same visibility rules as the app (busy-only stays hidden). */
export function feedPublicRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/:file", async (c) => {
    const token = c.req.param("file").replace(/\.ics$/, "");
    if (!/^[\w-]{20,64}$/.test(token)) return c.text("not found", 404);
    const db = getDb(c.env.DB);
    const [row] = await db
      .select({ feed: calendarFeeds, user: users })
      .from(calendarFeeds)
      .innerJoin(users, eq(users.id, calendarFeeds.userId))
      .where(and(eq(calendarFeeds.tokenHash, await sha256Hex(token)), isNull(calendarFeeds.revokedAt)))
      .limit(1);
    if (!row) return c.text("not found", 404);
    const today = new Date().toISOString().slice(0, 10);
    const list = await listVisibleEvents(db, row.user, { from: addDays(today, -PAST_DAYS), to: addDays(today, FUTURE_DAYS) });
    const touch = db.update(calendarFeeds).set({ lastFetchedAt: new Date().toISOString() }).where(eq(calendarFeeds.id, row.feed.id)).then(() => undefined);
    try { c.executionCtx.waitUntil(touch); } catch { await touch; }
    return c.body(toIcsCalendar(list, new URL(c.req.url).host, "Calendar Hub"), 200, {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "private, max-age=300",
    });
  });
  return r;
}
