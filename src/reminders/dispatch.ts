// Cron-side reminder dispatch: find reminders due now, push them, mark them sent,
// and prune dead subscriptions. Glue over the pure due-logic (due.ts), Web Push
// crypto (push.ts) and the database.
import { and, eq, gt, inArray, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/events";
import { eventReminders, events, pushSubscriptions, users } from "../db/schema";
import type { Env } from "../env";
import { dueReminders, type ReminderCandidate } from "./due";
import { sendWebPush, type PushResult } from "./push";

// Only scan events starting within this window (bounds the per-tick query).
const MAX_LEAD_MS = 7 * 24 * 60 * 60 * 1000;

export type PushSender = (
  endpoint: string,
  keys: { p256dh: string; auth: string },
  payload: string,
  env: Env,
) => Promise<PushResult>;

export type DispatchResult = { sent: number; pruned: number; reminders: number };

/** Send any reminders that have come due. `send` is injectable for tests. */
export async function dispatchReminders(db: Db, env: Env, nowMs: number = Date.now(), send: PushSender = sendWebPush): Promise<DispatchResult> {
  const nowIso = new Date(nowMs).toISOString();
  const horizonIso = new Date(nowMs + MAX_LEAD_MS).toISOString();

  const rows = await db
    .select({
      eventId: events.id,
      ownerId: events.ownerId,
      title: events.title,
      startAt: events.startAt,
      userDefault: users.reminderDefaultMinutes,
      overrideId: eventReminders.id,
      overrideMinutes: eventReminders.minutesBefore,
      sentAt: eventReminders.sentAt,
    })
    .from(events)
    .innerJoin(users, eq(users.id, events.ownerId))
    .leftJoin(eventReminders, eq(eventReminders.eventId, events.id))
    .where(and(isNotNull(events.startAt), gt(events.startAt, nowIso), lte(events.startAt, horizonIso)))
    .limit(2000);

  const candidates: ReminderCandidate[] = [];
  const meta = new Map<string, { ownerId: string; title: string; startAt: string; hasOverride: boolean; minutesBefore: number }>();
  for (const r of rows) {
    if (!r.startAt) continue;
    let minutesBefore: number | null;
    if (r.overrideId !== null) minutesBefore = r.overrideMinutes; // row present; null = disabled
    else minutesBefore = r.userDefault; // no row; fall back to the user default
    if (minutesBefore === null) continue;
    candidates.push({ eventId: r.eventId, startAt: r.startAt, minutesBefore, sentAt: r.sentAt });
    meta.set(r.eventId, { ownerId: r.ownerId, title: r.title, startAt: r.startAt, hasOverride: r.overrideId !== null, minutesBefore });
  }

  const due = dueReminders(candidates, nowMs, 0);
  if (due.length === 0) return { sent: 0, pruned: 0, reminders: 0 };

  const ownerIds = [...new Set(due.map((d) => meta.get(d.eventId)!.ownerId))];
  const subs = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, ownerIds));
  const subsByUser = new Map<string, typeof subs>();
  for (const s of subs) (subsByUser.get(s.userId) ?? subsByUser.set(s.userId, []).get(s.userId)!).push(s);

  let sent = 0;
  const goneSubIds: string[] = [];
  const firedEventIds: string[] = [];

  for (const d of due) {
    const m = meta.get(d.eventId)!;
    const userSubs = subsByUser.get(m.ownerId) ?? [];
    if (userSubs.length === 0) continue; // nobody to notify; leave unsent so it can fire once a device subscribes
    const payload = JSON.stringify({ title: m.title, eventId: d.eventId, startAt: m.startAt });
    for (const s of userSubs) {
      try {
        const res = await send(s.endpoint, { p256dh: s.p256dh, auth: s.auth }, payload, env);
        if (res.gone) goneSubIds.push(s.id);
        else if (res.ok) sent++;
      } catch {
        // transient failure: leave the subscription, the next tick retries
      }
    }
    firedEventIds.push(d.eventId);
  }

  // Mark each fired reminder sent so it does not repeat. Default-derived reminders
  // get a materialized row carrying the lead used.
  const writes: unknown[] = firedEventIds.map((eventId) => {
    const m = meta.get(eventId)!;
    return m.hasOverride
      ? db.update(eventReminders).set({ sentAt: nowIso }).where(eq(eventReminders.eventId, eventId))
      : db
          .insert(eventReminders)
          .values({ id: crypto.randomUUID(), eventId, minutesBefore: m.minutesBefore, sentAt: nowIso })
          .onConflictDoUpdate({ target: eventReminders.eventId, set: { sentAt: nowIso } });
  });
  if (goneSubIds.length) writes.push(db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, goneSubIds)));
  if (writes.length) await db.batch(writes as unknown as Parameters<Db["batch"]>[0]);

  return { sent, pruned: goneSubIds.length, reminders: firedEventIds.length };
}
