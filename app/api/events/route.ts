import { and, asc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { getChatGPTUser } from "../../chatgpt-auth";
import { getDb } from "../../../db";
import { events } from "../../../db/schema";
import { isValidEvent, parseEventInput, validDate, type EventInput } from "../../event-validation";

async function owner() { return getChatGPTUser(); }
function failure(error: unknown) {
  console.error("events api failure", error);
  return Response.json({ error: "予定を保存できませんでした。しばらくしてから再度お試しください。" }, { status: 500 });
}
export async function GET(request: Request) {
  const user = await owner();
  if (!user) return Response.json({ error: "ChatGPTへのサインインが必要です。" }, { status: 401 });
  try {
    const url = new URL(request.url), from = url.searchParams.get("from"), to = url.searchParams.get("to"), q = url.searchParams.get("q")?.trim();
    if (from && !validDate(from) || to && !validDate(to) || from && to && from > to || q && q.length > 120) return Response.json({ error: "検索条件が正しくありません。" }, { status: 400 });
    const filters: SQL[] = [eq(events.userId, user.userId)];
    if (from) filters.push(gte(events.date, from));
    if (to) filters.push(lte(events.date, to));
    if (q) filters.push(sql`instr(lower(${events.title}), lower(${q})) > 0`);
    const rows = await getDb().select().from(events).where(and(...filters)).orderBy(asc(events.date), asc(events.start));
    return Response.json({ events: rows });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const user = await owner();
  if (!user) return Response.json({ error: "ChatGPTへのサインインが必要です。" }, { status: 401 });
  try {
    let input: EventInput;
    try { input = parseEventInput(await request.json()); } catch { return Response.json({ error: "予定の内容が正しくありません。" }, { status: 400 }); }
    if (!isValidEvent(input)) return Response.json({ error: "タイトル・日付・時刻を確認してください。" }, { status: 400 });
    const now = new Date().toISOString();
    const db = getDb(), id = input.id && /^[\w-]{1,80}$/.test(input.id) ? input.id : crypto.randomUUID();
    const [event] = await db.insert(events).values({ id, userId: user.userId, title: input.title, date: input.date, allDay: input.allDay, start: input.allDay ? null : input.start, end: input.allDay ? null : input.end, category: input.category, createdAt: now, updatedAt: now }).onConflictDoNothing().returning();
    if (!event) {
      const [existing] = await db.select().from(events).where(and(eq(events.id, id), eq(events.userId, user.userId))).limit(1);
      if (existing) {
        const matches = existing.title === input.title && existing.date === input.date && existing.allDay === input.allDay && existing.start === (input.allDay ? null : input.start) && existing.end === (input.allDay ? null : input.end) && existing.category === input.category;
        if (matches) return Response.json({ event: existing }, { status: 200 });
        return Response.json({ error: "この予定IDには異なる内容が保存されています。最新の予定を再読み込みしてください。" }, { status: 409 });
      }
      return Response.json({ error: "予定IDが競合しました。再度お試しください。" }, { status: 409 });
    }
    return Response.json({ event }, { status: 201 });
  } catch (error) { return failure(error); }
}
