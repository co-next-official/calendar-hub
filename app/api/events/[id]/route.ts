import { and, eq } from "drizzle-orm";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { getDb } from "../../../../db";
import { events } from "../../../../db/schema";
import { isValidEvent, parseEventInput } from "../../../event-validation";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "ChatGPTへのサインインが必要です。" }, { status: 401 });
  try {
    const { id } = await context.params;
    let input: unknown;
    try { input = await request.json(); } catch { return Response.json({ error: "予定の内容が正しくありません。" }, { status: 400 }); }
    let parsed;
    try { parsed = parseEventInput(input); } catch { return Response.json({ error: "予定の内容が正しくありません。" }, { status: 400 }); }
    if (!isValidEvent(parsed)) return Response.json({ error: "予定の内容が正しくありません。" }, { status: 400 });
    const expectedUpdatedAt = input && typeof input === "object" && typeof (input as Record<string, unknown>).updatedAt === "string" ? (input as Record<string, string>).updatedAt : null;
    if (!expectedUpdatedAt) return Response.json({ error: "最新の予定情報を読み込んでから更新してください。" }, { status: 400 });
    const nextTime = Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1);
    const [event] = await getDb().update(events).set({ title: parsed.title, date: parsed.date, allDay: parsed.allDay, start: parsed.allDay ? null : parsed.start, end: parsed.allDay ? null : parsed.end, category: parsed.category, updatedAt: new Date(nextTime).toISOString() }).where(and(eq(events.id, id), eq(events.userId, user.userId), eq(events.updatedAt, expectedUpdatedAt))).returning();
    if (!event) { const [exists] = await getDb().select({ id: events.id }).from(events).where(and(eq(events.id, id), eq(events.userId, user.userId))).limit(1); return exists ? Response.json({ error: "別の更新が先に保存されました。最新の予定を再読み込みしてください。" }, { status: 409 }) : Response.json({ error: "予定が見つかりません。" }, { status: 404 }); }
    return Response.json({ event });
  } catch (error) { console.error(error); return Response.json({ error: "予定を更新できませんでした。" }, { status: 500 }); }
}
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "ChatGPTへのサインインが必要です。" }, { status: 401 });
  try {
    const { id } = await context.params;
    const [deleted] = await getDb().delete(events).where(and(eq(events.id, id), eq(events.userId, user.userId))).returning({ id: events.id });
    if (!deleted) return Response.json({ error: "予定が見つかりません。" }, { status: 404 });
    return Response.json({ success: true });
  } catch (error) { console.error(error); return Response.json({ error: "予定を削除できませんでした。" }, { status: 500 }); }
}
