import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseIdToken } from "../src/auth/google";
import { safeReturnTo } from "../src/auth/routes";
import { login, resetDb, testApp } from "./helpers";

beforeEach(resetDb);

describe("Google login", () => {
  it("redirects to Google with PKCE and a state cookie", async () => {
    const t = testApp();
    const res = await t.request("/auth/google/login?return_to=/");
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://cal.example.com/auth/google/callback");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("ch_oauth=") && c.includes("HttpOnly"))).toBe(true);
  });

  it("logs in, exposes /api/me, and logs out", async () => {
    const t = testApp();
    const { response, cookie } = await login(t, { sub: "g1", email: "me@example.com", name: "Me" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(cookie).not.toBe("");

    const me = await t.request("/api/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "me@example.com", name: "Me" });

    const out = await t.request("/auth/logout", { method: "POST", headers: { cookie } });
    expect(out.status).toBe(200);
    expect((await t.request("/api/me", { headers: { cookie } })).status).toBe(401);
  });

  it("reuses the same user on a second login", async () => {
    const t = testApp();
    await login(t, { sub: "g1", email: "me@example.com" });
    await login(t, { sub: "g1", email: "me@example.com" });
    const { results } = await env.DB.prepare("SELECT count(*) AS n FROM users").all<{ n: number }>();
    expect(results[0]!.n).toBe(1);
  });

  it("rejects a mismatched state", async () => {
    const t = testApp();
    t.accounts.set("c", { sub: "g1", email: "me@example.com", name: "", picture: null });
    const start = await t.request("/auth/google/login");
    const cookie = start.headers.getSetCookie()[0]!.split(";")[0]!;
    const cb = await t.request("/auth/google/callback?code=c&state=forged", { headers: { cookie } });
    expect(cb.headers.get("location")).toBe("/?login_error=state");
    expect(cb.headers.getSetCookie().some((c) => c.startsWith("ch_session="))).toBe(false);
  });

  it("enforces ALLOWED_EMAILS", async () => {
    const t = testApp();
    const original = env.ALLOWED_EMAILS;
    env.ALLOWED_EMAILS = "friend@example.com";
    try {
      const { response, cookie } = await login(t, { sub: "g2", email: "stranger@example.com" });
      expect(response.headers.get("location")).toBe("/?login_error=not_allowed");
      expect(cookie).toBe("");
    } finally {
      env.ALLOWED_EMAILS = original;
    }
  });

  it("requires a session for API routes and blocks cross-origin writes", async () => {
    const t = testApp();
    expect((await t.request("/api/me")).status).toBe(401);
    expect((await t.request("/api/me", { headers: { cookie: "ch_session=bogus" } })).status).toBe(401);
    const { cookie } = await login(t, { sub: "g1", email: "me@example.com" });
    const res = await t.request("/api/me", { method: "PATCH", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    expect(res.status).toBe(403);
  });

  it("lets the user rename themselves", async () => {
    const t = testApp();
    const { cookie } = await login(t, { sub: "g1", email: "me@example.com" });
    const res = await t.request("/api/me", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: " げんき " }) });
    expect(await res.json()).toMatchObject({ name: "げんき" });
  });
});

describe("helpers", () => {
  it("only allows same-site relative return paths", () => {
    expect(safeReturnTo("/week")).toBe("/week");
    expect(safeReturnTo("https://evil.example")).toBe("/");
    expect(safeReturnTo("//evil.example")).toBe("/");
    expect(safeReturnTo("/\\evil.example")).toBe("/");
    expect(safeReturnTo("/auth/google/login")).toBe("/");
  });

  it("validates ID token claims", () => {
    const enc = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const token = (claims: object) => `x.${enc(claims)}.sig`;
    const good = { iss: "https://accounts.google.com", aud: "cid", exp: 2_000_000_000, sub: "1", email: "A@Example.com", email_verified: true };
    expect(parseIdToken(token(good), "cid", 1_900_000_000).email).toBe("a@example.com");
    expect(() => parseIdToken(token({ ...good, aud: "other" }), "cid", 1_900_000_000)).toThrow("bad_audience");
    expect(() => parseIdToken(token({ ...good, iss: "https://evil" }), "cid", 1_900_000_000)).toThrow("bad_issuer");
    expect(() => parseIdToken(token({ ...good, email_verified: false }), "cid", 1_900_000_000)).toThrow("unverified_email");
    expect(() => parseIdToken(token(good), "cid", 2_100_000_000)).toThrow("expired_id_token");
  });
});
