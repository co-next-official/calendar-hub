import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/events";
import { events, googleConnections, type GoogleConnection } from "../db/schema";
import type { Env } from "../env";
import { isTimeZone, validateEvent } from "../events/validate";
import { open, seal } from "../lib/secretbox";
import { GoogleAuthError, SyncTokenExpired, type GoogleApi, type GoogleEvent } from "./client";

const INITIAL_LOOKBACK_DAYS = 90;
const MAX_PAGES = 40;

export type SyncResult = { upserted: number; deleted: number; skipped: number; full: boolean };

async function accessTokenFor(db: Db, env: Env, api: GoogleApi, conn: GoogleConnection): Promise<string> {
  if (conn.accessTokenEnc && conn.accessExpiresAt && conn.accessExpiresAt > new Date(Date.now() + 60_000).toISOString()) {
    return open(conn.accessTokenEnc, env.GOOGLE_TOKEN_KEY);
  }
  const refreshToken = await open(conn.refreshTokenEnc, env.GOOGLE_TOKEN_KEY);
  const { accessToken, expiresIn } = await api.refreshAccessToken({ clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, refreshToken });
  await db.update(googleConnections).set({
    accessTokenEnc: await seal(accessToken, env.GOOGLE_TOKEN_KEY),
    accessExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  }).where(eq(googleConnections.id, conn.id));
  return accessToken;
}

/** Converts a Google event to our fields; null if it cannot be represented (e.g. > 31 day timed span). */
export function mapGoogleEvent(g: GoogleEvent, calendarTz: string | undefined) {
  const tz = [g.start?.timeZone, calendarTz].find(isTimeZone) ?? "Asia/Tokyo";
  const base = { title: (g.summary?.trim() || "(タイトルなし)").slice(0, 120), notes: (g.description ?? "").slice(0, 2000), timezone: tz, category: "personal" };
  const r = g.start?.date
    ? validateEvent({ ...base, all_day: true, start_date: g.start.date, end_date: g.end?.date })
    : validateEvent({ ...base, all_day: false, start_at: g.start?.dateTime, end_at: g.end?.dateTime });
  return r.ok ? r.value : null;
}

export async function syncConnection(db: Db, env: Env, api: GoogleApi, conn: GoogleConnection): Promise<SyncResult> {
  const result: SyncResult = { upserted: 0, deleted: 0, skipped: 0, full: !conn.syncToken };
  try {
    const accessToken = await accessTokenFor(db, env, api, conn);
    let syncToken = conn.syncToken ?? undefined;
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    const timeMin = new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86_400_000).toISOString();
    // On a full sync, everything Google still has gets touched; whatever is left untouched afterwards was deleted there.
    const startedAt = new Date().toISOString();
    for (let page = 0; page < MAX_PAGES; page++) {
      let res;
      try {
        res = await api.listEvents({ accessToken, calendarId: conn.calendarId, syncToken, pageToken, timeMin: syncToken ? undefined : timeMin });
      } catch (err) {
        if (err instanceof SyncTokenExpired && syncToken) {
          // Google invalidated the cursor: drop it and do a full resync.
          await db.update(googleConnections).set({ syncToken: null }).where(eq(googleConnections.id, conn.id));
          return syncConnection(db, env, api, { ...conn, syncToken: null });
        }
        throw err;
      }
      for (const g of res.items) {
        if (g.status === "cancelled") {
          const gone = await db.delete(events).where(and(eq(events.connectionId, conn.id), eq(events.externalId, g.id))).returning({ id: events.id });
          result.deleted += gone.length;
          continue;
        }
        const fields = mapGoogleEvent(g, res.timeZone);
        if (!fields) { result.skipped++; continue; }
        await db
          .insert(events)
          .values({ id: crypto.randomUUID(), ownerId: conn.userId, ...fields, source: "google", connectionId: conn.id, externalId: g.id, updatedAt: new Date().toISOString() })
          .onConflictDoUpdate({
            target: [events.connectionId, events.externalId],
            set: { ...fields, version: sql`${events.version} + 1`, updatedAt: new Date().toISOString() },
          });
        result.upserted++;
      }
      pageToken = res.nextPageToken;
      nextSyncToken = res.nextSyncToken ?? nextSyncToken;
      if (!pageToken) break;
    }
    if (result.full && !pageToken) {
      const stale = await db.delete(events).where(and(eq(events.connectionId, conn.id), lt(events.updatedAt, startedAt))).returning({ id: events.id });
      result.deleted += stale.length;
    }
    await db.update(googleConnections).set({ syncToken: nextSyncToken ?? null, lastSyncedAt: new Date().toISOString(), lastError: null }).where(eq(googleConnections.id, conn.id));
    return result;
  } catch (err) {
    const message = err instanceof GoogleAuthError ? "Googleの許可が切れています。連携し直してください" : `同期に失敗しました（${(err as Error).message.slice(0, 120)}）`;
    await db.update(googleConnections).set({ lastError: message }).where(eq(googleConnections.id, conn.id));
    throw err;
  }
}

/** Cron entry: sync every connection, isolating failures. */
export async function syncAll(db: Db, env: Env, api: GoogleApi) {
  const conns = await db.select().from(googleConnections);
  for (const conn of conns) {
    try { await syncConnection(db, env, api, conn); } catch (err) { console.error("google sync failed", conn.id, err); }
  }
}
