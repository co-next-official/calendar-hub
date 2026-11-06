// Remote MCP server (Streamable HTTP, JSON responses). Every tool calls the existing REST API with the
// caller's own API key, so scopes, audit logging and the delete confirmation rule all still apply.
import { Hono } from "hono";
import { getDb } from "../db/events";
import type { AppEnv, Env } from "../env";
import { findToken } from "../auth/tokens";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  request: (args: Record<string, any>) => { method: string; path: string; body?: unknown };
};

const dateProp = { type: "string", description: "YYYY-MM-DD" };
const eventFields = {
  title: { type: "string" },
  notes: { type: "string" },
  category: { type: "string", enum: ["work", "personal", "team"] },
  all_day: { type: "boolean" },
  start_date: { ...dateProp, description: "終日予定の開始日" },
  end_date: { ...dateProp, description: "終日予定の終了日（含まない）" },
  start_at: { type: "string", description: "開始日時。オフセット付き ISO 8601（例 2026-11-10T10:00:00+09:00）" },
  end_at: { type: "string", description: "終了日時（含まない）" },
  timezone: { type: "string", description: "IANA タイムゾーン。既定 Asia/Tokyo" },
};

const TOOLS: Tool[] = [
  {
    name: "list_events",
    description: "期間内の予定（自分の予定と共有された予定）を一覧する。他人の busy-only の予定はタイトルが「予定あり」になる。",
    inputSchema: { type: "object", properties: { from: dateProp, to: { ...dateProp, description: "この日を含まない" }, q: { type: "string", description: "タイトル検索" } }, required: ["from", "to"] },
    request: (a) => ({ method: "GET", path: `/api/events?${new URLSearchParams({ from: a.from, to: a.to, ...(a.q ? { q: a.q } : {}) })}` }),
  },
  {
    name: "get_event",
    description: "予定を1件取得する。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    request: (a) => ({ method: "GET", path: `/api/events/${encodeURIComponent(a.id)}` }),
  },
  {
    name: "find_free_time",
    description: "自分、または参加中のグループ全員の共通の空き時間を探す。返るのは空き枠だけ。",
    inputSchema: {
      type: "object",
      properties: {
        from: dateProp, to: { ...dateProp, description: "この日を含まない（31日以内）" }, group_id: { type: "string", description: "list_groups の id。省略で自分だけ" },
        duration_minutes: { type: "integer", minimum: 15, maximum: 720 }, day_start: { type: "string", description: "HH:MM（既定 09:00）" }, day_end: { type: "string", description: "HH:MM（既定 21:00）" },
        timezone: { type: "string" },
      },
      required: ["from", "to"],
    },
    request: (a) => {
      const q = new URLSearchParams({ from: a.from, to: a.to });
      if (a.group_id) q.set("group_id", a.group_id);
      if (a.duration_minutes) q.set("duration", String(a.duration_minutes));
      if (a.day_start) q.set("day_start", a.day_start);
      if (a.day_end) q.set("day_end", a.day_end);
      if (a.timezone) q.set("timezone", a.timezone);
      return { method: "GET", path: `/api/availability?${q}` };
    },
  },
  {
    name: "list_groups",
    description: "参加中のグループを一覧する（find_free_time の group_id に使う）。",
    inputSchema: { type: "object", properties: {} },
    request: () => ({ method: "GET", path: "/api/groups" }),
  },
  {
    name: "create_event",
    description: "予定を作成する（書き込み権限のある API キーが必要）。時間が重なる自分の予定があれば conflicts に入るので、ユーザーに伝えること。",
    inputSchema: { type: "object", properties: eventFields, required: ["title"] },
    request: (a) => ({ method: "POST", path: "/api/events", body: a }),
  },
  {
    name: "update_event",
    description: "予定を更新する。version は get_event で得た値を渡す（古いと競合エラー）。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "integer" }, ...eventFields }, required: ["id", "version"] },
    request: ({ id, ...rest }) => ({ method: "PATCH", path: `/api/events/${encodeURIComponent(id)}`, body: rest }),
  },
  {
    name: "delete_event",
    description: "予定を削除する。必ず先にユーザーへ削除してよいか確認し、了承を得たときだけ confirm: true を付けて呼ぶこと。",
    inputSchema: { type: "object", properties: { id: { type: "string" }, confirm: { type: "boolean", description: "ユーザーが削除を了承したら true" } }, required: ["id", "confirm"] },
    request: (a) => ({ method: "DELETE", path: `/api/events/${encodeURIComponent(a.id)}${a.confirm === true ? "?confirm=true" : ""}` }),
  },
];

type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, any> };

const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** `api` performs an internal request against the app with the caller's Authorization header. */
export function mcpRoutes(api: (env: Env, method: string, path: string, authorization: string, body?: unknown) => Promise<Response>) {
  const r = new Hono<AppEnv>();

  r.get("/", (c) => c.json(rpcError(null, -32000, "Use POST (Streamable HTTP, JSON responses)"), 405, { allow: "POST" }));

  r.post("/", async (c) => {
    const authorization = c.req.header("authorization") ?? "";
    const raw = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    if (!raw || !(await findToken(getDb(c.env.DB), raw))) {
      return c.json(rpcError(null, -32001, "Calendar Hub の API キー（Authorization: Bearer chk_...）が必要です"), 401, { "www-authenticate": 'Bearer realm="calendar-hub"' });
    }

    let payload: unknown;
    try { payload = await c.req.json(); } catch { return c.json(rpcError(null, -32700, "Parse error"), 400); }
    const batch = Array.isArray(payload);
    const messages = (batch ? payload : [payload]) as RpcRequest[];

    const handle = async (m: RpcRequest) => {
      if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return rpcError(m?.id, -32600, "Invalid Request");
      const isNotification = m.id === undefined;
      switch (m.method) {
        case "initialize": {
          const requested = m.params?.protocolVersion;
          return rpcResult(m.id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "calendar-hub", version: "1.0.0" },
            instructions: "Calendar Hub の予定を読み書きする。削除は必ずユーザーに確認してから confirm: true で行う。日時はオフセット付きで渡す。",
          });
        }
        case "notifications/initialized":
        case "notifications/cancelled":
          return null;
        case "ping":
          return rpcResult(m.id, {});
        case "tools/list":
          return rpcResult(m.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case "tools/call": {
          const tool = TOOLS.find((t) => t.name === m.params?.name);
          if (!tool) return rpcError(m.id, -32602, `Unknown tool: ${m.params?.name}`);
          const args = (m.params?.arguments ?? {}) as Record<string, any>;
          const missing = ((tool.inputSchema.required as string[] | undefined) ?? []).filter((k) => args[k] === undefined);
          if (missing.length) return rpcResult(m.id, { content: [{ type: "text", text: `必須の引数がありません: ${missing.join(", ")}` }], isError: true });
          const req = tool.request(args);
          const res = await api(c.env, req.method, req.path, authorization, req.body);
          const text = await res.text();
          return rpcResult(m.id, { content: [{ type: "text", text }], isError: !res.ok });
        }
        default:
          return isNotification ? null : rpcError(m.id, -32601, `Method not found: ${m.method}`);
      }
    };

    const results = (await Promise.all(messages.map(handle))).filter((x) => x !== null);
    if (!results.length) return c.body(null, 202);
    return c.json(batch ? results : results[0]);
  });

  return r;
}
