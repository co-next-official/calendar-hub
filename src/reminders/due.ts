// Pure reminder-firing logic: decide which reminders fall due on a cron tick.
// No I/O and no Date.now(); the caller passes the tick window (sinceMs, nowMs].

export type ReminderCandidate = {
  eventId: string;
  startAt: string; // ISO-8601 UTC instant of the event start (timed events only)
  minutesBefore: number; // lead time in minutes
  sentAt: string | null; // ISO string if the reminder was already sent, else null
};

export type DueReminder = { eventId: string; fireAt: number }; // fireAt = epoch ms

/**
 * Reminders whose fire time (startAt - minutesBefore) lands in the tick window
 * (sinceMs, nowMs], are not yet sent, have a non-negative lead, parse cleanly,
 * and whose event has not started yet. Sorted by fireAt ascending (ties keep input order).
 */
export function dueReminders(
  candidates: ReminderCandidate[],
  nowMs: number,
  sinceMs: number,
): DueReminder[] {
  const included: Array<{ eventId: string; fireAt: number; index: number }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;

    if (candidate.sentAt !== null) continue;
    if (!(candidate.minutesBefore >= 0)) continue;

    const startMs = Date.parse(candidate.startAt);
    if (Number.isNaN(startMs)) continue;
    if (!(startMs > nowMs)) continue;

    const fireAt = startMs - candidate.minutesBefore * 60000;
    if (!(sinceMs < fireAt && fireAt <= nowMs)) continue;

    included.push({ eventId: candidate.eventId, fireAt, index: i });
  }

  included.sort((a, b) => (a.fireAt !== b.fireAt ? a.fireAt - b.fireAt : a.index - b.index));
  return included.map((item) => ({ eventId: item.eventId, fireAt: item.fireAt }));
}
