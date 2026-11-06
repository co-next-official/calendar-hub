import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie";
import { getDb } from "../db/events";
import { users } from "../db/schema";
import type { AppEnv, Deps } from "../env";
import { randomToken, sha256Base64url } from "../lib/crypto";
import { buildAuthUrl } from "./google";
import { createSession, deleteSession, getSessionUser, isEmailAllowed, SESSION_COOKIE, SESSION_TTL_SEC, upsertUser } from "./session";
import { eq } from "drizzle-orm";

const STATE_COOKIE = "ch_oauth";

export function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value.startsWith("/auth/")) return "/";
  return value.slice(0, 512);
}

function secure(url: string) {
  return new URL(url).protocol === "https:";
}

export function authRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.get("/google/login", async (c) => {
    const { GOOGLE_CLIENT_ID, SESSION_SECRET } = c.env;
    if (!GOOGLE_CLIENT_ID || !SESSION_SECRET) return c.text("Google ログインが未設定です（GOOGLE_CLIENT_ID / SESSION_SECRET）", 500);
    const state = randomToken(16);
    const verifier = randomToken(32);
    const returnTo = safeReturnTo(c.req.query("return_to"));
    await setSignedCookie(c, STATE_COOKIE, JSON.stringify({ state, verifier, returnTo }), SESSION_SECRET, {
      httpOnly: true, secure: secure(c.req.url), sameSite: "Lax", path: "/auth/google", maxAge: 600,
    });
    const redirectUri = new URL("/auth/google/callback", c.req.url).toString();
    return c.redirect(buildAuthUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri, state, codeChallenge: await sha256Base64url(verifier) }));
  });

  r.get("/google/callback", async (c) => {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET } = c.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SESSION_SECRET) return c.text("Google ログインが未設定です", 500);
    const raw = await getSignedCookie(c, SESSION_SECRET, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/auth/google", secure: secure(c.req.url) });
    let saved: { state: string; verifier: string; returnTo: string };
    try {
      saved = JSON.parse(raw || "");
    } catch {
      return c.redirect("/?login_error=state");
    }
    const code = c.req.query("code");
    if (!code || c.req.query("state") !== saved.state) return c.redirect("/?login_error=state");

    let claims;
    try {
      claims = await deps.exchangeCode({
        clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, code, codeVerifier: saved.verifier,
        redirectUri: new URL("/auth/google/callback", c.req.url).toString(),
      });
    } catch (err) {
      console.error("google login failed", err);
      return c.redirect("/?login_error=google");
    }
    if (!isEmailAllowed(claims.email, c.env.ALLOWED_EMAILS)) return c.redirect("/?login_error=not_allowed");

    const db = getDb(c.env.DB);
    const user = await upsertUser(db, claims);
    const token = await createSession(db, user.id);
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: secure(c.req.url), sameSite: "Lax", path: "/", maxAge: SESSION_TTL_SEC });
    return c.redirect(safeReturnTo(saved.returnTo));
  });

  r.post("/logout", async (c) => {
    await deleteSession(getDb(c.env.DB), getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secure(c.req.url) });
    return c.json({ ok: true });
  });

  return r;
}

/** Resolves the session cookie to a user, or answers 401. Also blocks cross-site state-changing requests. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "cross_origin" }, 403);
  }
  const user = await getSessionUser(getDb(c.env.DB), getCookie(c, SESSION_COOKIE));
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
};

export function meRoutes() {
  const r = new Hono<AppEnv>();
  const view = (u: AppEnv["Variables"]["user"]) => ({ id: u.id, email: u.email, name: u.name, avatar_url: u.avatarUrl });

  r.get("/", (c) => c.json(view(c.get("user"))));

  r.patch("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = body && typeof body === "object" ? (body as Record<string, unknown>).name : undefined;
    if (typeof name !== "string" || name.trim().length > 60) return c.json({ error: "invalid_name" }, 400);
    const [row] = await getDb(c.env.DB).update(users).set({ name: name.trim() }).where(eq(users.id, c.get("user").id)).returning();
    return c.json(view(row!));
  });

  return r;
}
