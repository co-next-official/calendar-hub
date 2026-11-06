import { beforeEach, describe, expect, it } from "vitest";
import { login, resetDb, testApp } from "./helpers";

beforeEach(resetDb);

async function setup(scopes: string[]) {
  const t = testApp();
  const { cookie } = await login(t, { sub: "a", email: "alice@example.com" });
  const res = await t.request("/api/tokens", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "mcp", scopes }) });
  const { token } = (await res.json()) as { token: string };
  let id = 0;
  const rpc = async (method: string, params?: unknown, key = token) => {
    const r = await t.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, any> };
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const { body } = await rpc("tools/call", { name, arguments: args });
    const result = body.result;
    return { isError: result.isError as boolean, data: JSON.parse(result.content[0].text) as Record<string, any> };
  };
  return { t, cookie, rpc, tool };
}

describe("MCP endpoint", () => {
  it("initializes and lists tools", async () => {
    const { rpc } = await setup(["read"]);
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "calendar-hub" }, capabilities: { tools: {} } });
    const list = await rpc("tools/list");
    expect(list.body.result.tools.map((x: any) => x.name)).toEqual(["list_events", "get_event", "find_free_time", "list_groups", "create_event", "update_event", "delete_event"]);
    expect((await rpc("no/such")).body.error.code).toBe(-32601);
  });

  it("requires a valid API key", async () => {
    const { rpc } = await setup(["read"]);
    const r = await rpc("tools/list", undefined, "chk_wrong");
    expect(r.status).toBe(401);
  });

  it("runs tools through the REST API with the key's own scopes", async () => {
    const { tool, rpc } = await setup(["read"]);
    const created = await tool("create_event", { title: "x", start_date: "2026-11-20" });
    expect(created.isError).toBe(true);
    expect(created.data.error).toBe("insufficient_scope");
    const listed = await tool("list_events", { from: "2026-11-01", to: "2026-12-01" });
    expect(listed).toMatchObject({ isError: false, data: { events: [] } });
    const missing = await rpc("tools/call", { name: "list_events", arguments: {} });
    expect(missing.body.result.isError).toBe(true);
  });

  it("creates, updates and deletes (only with confirm) with a write key", async () => {
    const { tool } = await setup(["read", "write"]);
    const { data: e } = await tool("create_event", { title: "MCPから", start_at: "2026-11-20T10:00:00+09:00", end_at: "2026-11-20T11:00:00+09:00" });
    expect(e).toMatchObject({ title: "MCPから", source: "api" });
    const updated = await tool("update_event", { id: e.id, version: e.version, title: "MCPから（変更）" });
    expect(updated.data.title).toBe("MCPから（変更）");
    const refused = await tool("delete_event", { id: e.id, confirm: false });
    expect(refused).toMatchObject({ isError: true, data: { error: "confirmation_required" } });
    expect((await tool("delete_event", { id: e.id, confirm: true })).isError).toBe(false);
    expect((await tool("get_event", { id: e.id })).isError).toBe(true);
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const t = testApp();
    const { cookie } = await login(t, { sub: "a", email: "alice@example.com" });
    const { token } = (await (await t.request("/api/tokens", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "mcp" }) })).json()) as { token: string };
    const r = await t.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
  });
});
