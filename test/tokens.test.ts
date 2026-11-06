import { beforeEach, describe, expect, it } from "vitest";
import { login, resetDb, testApp } from "./helpers";

beforeEach(resetDb);

async function setup() {
  const t = testApp();
  const { cookie } = await login(t, { sub: "a", email: "alice@example.com" });
  const asSession = async (method: string, path: string, body?: unknown) => {
    const res = await t.request(path, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const asKey = async (key: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await t.request(path, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { t, cookie, asSession, asKey };
}

const event = { title: "AIが入れた予定", start_at: "2026-11-10T10:00:00+09:00", end_at: "2026-11-10T11:00:00+09:00" };

describe("API keys", () => {
  it("issues a read-only key by default and shows the raw key once", async () => {
    const { asSession } = await setup();
    const created = await asSession("POST", "/api/tokens", { name: "Claude" });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^chk_/);
    expect(created.body.scopes).toEqual(["read"]);
    const list = await asSession("GET", "/api/tokens");
    expect(list.body.tokens).toHaveLength(1);
    expect(list.body.tokens[0]).not.toHaveProperty("token");
    expect(JSON.stringify(list.body)).not.toContain(created.body.token);
  });

  it("enforces scopes: read keys cannot write", async () => {
    const { asSession, asKey } = await setup();
    const { body } = await asSession("POST", "/api/tokens", { name: "reader" });
    expect((await asKey(body.token, "GET", "/api/events?from=2026-11-01&to=2026-12-01")).status).toBe(200);
    const write = await asKey(body.token, "POST", "/api/events", event);
    expect(write.status).toBe(403);
    expect(write.body.error).toBe("insufficient_scope");
  });

  it("lets write keys create events as the key owner, and audits every call", async () => {
    const { asSession, asKey } = await setup();
    const { body } = await asSession("POST", "/api/tokens", { name: "writer", scopes: ["read", "write"] });
    const created = await asKey(body.token, "POST", "/api/events", event);
    expect(created.status).toBe(201);
    const mine = await asSession("GET", "/api/events?from=2026-11-01&to=2026-12-01");
    expect(mine.body.events.map((e: any) => e.title)).toEqual(["AIが入れた予定"]);
    const audit = await asSession("GET", "/api/tokens/audit");
    expect(audit.body.entries[0]).toMatchObject({ method: "POST", path: "/api/events", status: 201 });
  });

  it("requires explicit confirmation before a key deletes", async () => {
    const { asSession, asKey } = await setup();
    const { body } = await asSession("POST", "/api/tokens", { name: "writer", scopes: ["read", "write"] });
    const { body: e } = await asKey(body.token, "POST", "/api/events", event);
    expect((await asKey(body.token, "DELETE", `/api/events/${e.id}`)).status).toBe(428);
    expect((await asKey(body.token, "DELETE", `/api/events/${e.id}?confirm=true`)).status).toBe(200);
  });

  it("cannot manage keys with a key, and revoked keys stop working", async () => {
    const { asSession, asKey } = await setup();
    const { body } = await asSession("POST", "/api/tokens", { name: "writer", scopes: ["read", "write"] });
    expect((await asKey(body.token, "POST", "/api/tokens", { name: "escalate", scopes: ["read", "write"] })).status).toBe(403);
    expect((await asKey(body.token, "GET", "/api/tokens")).status).toBe(403);

    expect((await asSession("DELETE", `/api/tokens/${body.id}`)).status).toBe(200);
    expect((await asKey(body.token, "GET", "/api/me")).status).toBe(401);
  });

  it("ignores the session cookie when an Authorization header is present", async () => {
    const { t, cookie } = await setup();
    const res = await t.request("/api/me", { headers: { cookie, authorization: "Bearer chk_wrong" } });
    expect(res.status).toBe(401);
  });

  it("does not let one user's key see another user's events", async () => {
    const { t, asSession, asKey } = await setup();
    await asSession("POST", "/api/events", event);
    const bob = (await login(t, { sub: "b", email: "bob@example.com" })).cookie;
    const bobKey = await t.request("/api/tokens", { method: "POST", headers: { cookie: bob, "content-type": "application/json" }, body: JSON.stringify({ name: "bob" }) });
    const { token } = (await bobKey.json()) as { token: string };
    expect((await asKey(token, "GET", "/api/events?from=2026-11-01&to=2026-12-01")).body.events).toEqual([]);
  });
});
