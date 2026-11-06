// Input validation for events. Pure functions so they can be unit-tested.

export const CATEGORIES = ["work", "personal", "team"] as const;
export type Category = (typeof CATEGORIES)[number];

export type EventFields = {
  title: string;
  notes: string;
  category: Category;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  startAt: string | null;
  endAt: string | null;
  timezone: string;
};

export type ValidationResult = { ok: true; value: EventFields } | { ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_RE = /(?:Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;
const MAX_TIMED_MS = 31 * DAY_MS;
const MAX_ALL_DAY_DAYS = 366;

export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Normalizes an ISO 8601 timestamp with an explicit offset to UTC `...Z`. */
export function toInstant(value: unknown): string | null {
  if (typeof value !== "string" || !OFFSET_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const EMPTY: EventFields = { title: "", notes: "", category: "personal", allDay: false, startDate: null, endDate: null, startAt: null, endAt: null, timezone: "Asia/Tokyo" };
const TIME_KEYS = ["all_day", "start_date", "end_date", "start_at", "end_at"];

/**
 * Validates a create (base undefined) or partial update (base = current row) payload.
 * Accepts snake_case API field names.
 */
export function validateEvent(input: unknown, base?: EventFields): ValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "invalid_body" };
  const raw = input as Record<string, unknown>;
  const has = (k: string) => raw[k] !== undefined;
  const v: EventFields = { ...(base ?? EMPTY) };

  if (has("title")) {
    if (typeof raw.title !== "string") return { ok: false, error: "invalid_title" };
    v.title = raw.title.trim();
  }
  if (!v.title || v.title.length > 120) return { ok: false, error: "invalid_title" };

  if (has("notes")) {
    if (typeof raw.notes !== "string" || raw.notes.length > 2000) return { ok: false, error: "invalid_notes" };
    v.notes = raw.notes;
  }
  if (has("category")) {
    if (!CATEGORIES.includes(raw.category as Category)) return { ok: false, error: "invalid_category" };
    v.category = raw.category as Category;
  }
  if (has("timezone")) {
    if (!isTimeZone(raw.timezone)) return { ok: false, error: "invalid_timezone" };
    v.timezone = raw.timezone;
  }

  if (base && !TIME_KEYS.some(has)) return { ok: true, value: v };

  if (has("all_day")) {
    if (typeof raw.all_day !== "boolean") return { ok: false, error: "invalid_all_day" };
    v.allDay = raw.all_day;
  } else if (!base) {
    v.allDay = has("start_date") && !has("start_at");
  }

  if (v.allDay) {
    const start = has("start_date") ? raw.start_date : v.startDate;
    if (!isDate(start)) return { ok: false, error: "invalid_start_date" };
    // Keep the existing end only when neither date was touched; otherwise default to a one-day event.
    const end = has("end_date") ? raw.end_date : !has("start_date") && v.endDate ? v.endDate : addDays(start, 1);
    if (!isDate(end) || end <= start) return { ok: false, error: "invalid_end_date" };
    if (Date.parse(end) - Date.parse(start) > MAX_ALL_DAY_DAYS * DAY_MS) return { ok: false, error: "range_too_long" };
    return { ok: true, value: { ...v, startDate: start, endDate: end, startAt: null, endAt: null } };
  }

  const startAt = toInstant(has("start_at") ? raw.start_at : v.startAt);
  const endAt = toInstant(has("end_at") ? raw.end_at : v.endAt);
  if (!startAt) return { ok: false, error: "invalid_start_at" };
  if (!endAt || endAt <= startAt) return { ok: false, error: "invalid_end_at" };
  if (Date.parse(endAt) - Date.parse(startAt) > MAX_TIMED_MS) return { ok: false, error: "range_too_long" };
  return { ok: true, value: { ...v, startAt, endAt, startDate: null, endDate: null } };
}
