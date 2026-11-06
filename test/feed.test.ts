import { beforeEach, describe, expect, it } from "vitest";
import { login, resetDb, testApp } from "./helpers";

beforeEach(resetDb);

const soon = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

describe("iCalendar subscription feed", () => {
  it("serves my events (with busy-only redaction) at a secret, regenerable URL", async () => {
    const t = testApp();
    const as = async (sub: string, email: string) => {
      const { cookie } = await login(t, { sub, email });
      return async (method: string, path: string, body?: unknown) => {
        const res = await t.request(path, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
      };
    };
    const alice = await as("a", "alice@example.com"), bob = await as("b", "bob@example.com");
    await alice("POST", "/api/events", { title: "自分の予定", start_at: soon(24), end_at: soon(25) });
    const { body: secret } = await bob("POST", "/api/events", { title: "Bobの秘密", start_at: soon(48), end_at: soon(49) });
    await bob("PUT", `/api/events/${secret.id}/sharing`, { visibility: "participants", participants: ["alice@example.com"], busy_only: true });

    const { body: feed } = await alice("POST", "/api/feed");
    expect(feed.url).toMatch(/\/feed\/[\w-]+\.ics$/);
    expect(feed.webcal_url).toMatch(/^webcal:/);
    const path = new URL(feed.url).pathname;

    const ics = await (await t.request(path)).text();
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("SUMMARY:自分の予定");
    expect(ics).toContain("SUMMARY:予定あり");
    expect(ics).not.toContain("Bobの秘密");
    expect((await alice("GET", "/api/feed")).body.last_fetched_at).toBeTruthy();

    // Regenerating invalidates the old URL; revoking kills the new one.
    const { body: second } = await alice("POST", "/api/feed");
    expect((await t.request(path)).status).toBe(404);
    expect((await t.request(new URL(second.url).pathname)).status).toBe(200);
    await alice("DELETE", "/api/feed");
    expect((await t.request(new URL(second.url).pathname)).status).toBe(404);
  });

  it("cannot be managed with an API key", async () => {
    const t = testApp();
    const { cookie } = await login(t, { sub: "a", email: "alice@example.com" });
    const key = (await (await t.request("/api/tokens", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "k", scopes: ["read", "write"] }) })).json()) as { token: string };
    expect((await t.request("/api/feed", { method: "POST", headers: { authorization: `Bearer ${key.token}` } })).status).toBe(403);
  });
});
