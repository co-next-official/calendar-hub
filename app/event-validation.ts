const dateRE = /^\d{4}-\d{2}-\d{2}$/;
const timeRE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const categories = ["work", "personal", "team"] as const;
export type EventInput = { id?: string; title: string; date: string; allDay: boolean; start: string | null; end: string | null; category: typeof categories[number] };
export function validDate(s: unknown): s is string {
  if (typeof s !== "string" || !dateRE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s;
}
export function parseEventInput(input: unknown): EventInput {
  if (!input || typeof input !== "object") throw new Error("invalid");
  const raw = input as Record<string, unknown>;
  return { id: typeof raw.id === "string" ? raw.id : undefined, title: typeof raw.title === "string" ? raw.title.trim() : "", date: typeof raw.date === "string" ? raw.date : "", allDay: raw.allDay === true, start: typeof raw.start === "string" ? raw.start : null, end: typeof raw.end === "string" ? raw.end : null, category: (typeof raw.category === "string" ? raw.category : "personal") as EventInput["category"] };
}
export function isValidEvent(v: EventInput): boolean {
  return v.title.length > 0 && v.title.length <= 120 && validDate(v.date) && (v.allDay || Boolean(v.start && v.end && timeRE.test(v.start) && timeRE.test(v.end) && v.start < v.end)) && (v.category === "work" || v.category === "personal" || v.category === "team");
}
