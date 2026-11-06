import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { getSessionUser, SESSION_COOKIE } from "../auth/session";
import { getDb } from "../db/events";
import { events, googleConnections } from "../db/schema";
import type { AppEnv, Deps } from "../env";
import { randomToken, sha256Base64url } from "../lib/crypto";
import { open, seal } from "../lib/secretbox";
import { CALENDAR_SCOPE } from "./client";
import { syncConnection } from "./sync";

const STATE_COOKIE = "ch_gcal";
const secure = (url: string) => new URL(url).protocol === "https:";

/** /auth/google/calendar/* — browser redirects for granting read access to Google Calendar. */
export function googleConnectRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.get("/connect", async (c) => {
    const { GOOGLE_CLIENT_ID, SESSION_SECRET, GOOGLE_TOKEN_KEY } = c.env;
    if (!GOOGLE_CLIENT_ID || !SESSION_SECRET || !GOOGLE_TOKEN_KEY) return c.text("Google カレンダー連携が未設定です（GOOGLE_TOKEN_KEY など）", 500);
    const user = await getSessionUser(getDb(c.env.DB), getCookie(c, SESSION_COOKIE));
    if (!user) return c.redirect("/");
    const state = randomToken(16), verifier = randomToken(32);
    await setSignedCookie(c, STATE_COOKIE, JSON.stringify({ state, verifier, userId: user.id }), SESSION_SECRET, {
      httpOnly: true, secure: secure(c.req.url), sameSite: "Lax", path: "/auth/google/calendar", maxAge: 600,
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: new URL("/auth/google/calendar/callback", c.req.url).toString(),
      response_type: "code",
      scope: `openid email ${CALENDAR_SCOPE}`,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      login_hint: user.email,
      state,
      code_challenge: await sha256Base64url(verifier),
      code_challenge_method: "S256",
    }).toString();
    return c.redirect(url.toString());
  });

  r.get("/callback", async (c) => {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET, GOOGLE_TOKEN_KEY } = c.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SESSION_SECRET || !GOOGLE_TOKEN_KEY) return c.text("Google カレンダー連携が未設定です", 500);
    const raw = await getSignedCookie(c, SESSION_SECRET, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/auth/google/calendar", secure: secure(c.req.url) });
    let saved: { state: string; verifier: string; userId: string };
    try { saved = JSON.parse(raw || ""); } catch { return c.redirect("/?google=state_error"); }
    const db = getDb(c.env.DB);
    const user = await getSessionUser(db, getCookie(c, SESSION_COOKIE));
    // The grant must come back to the same signed-in user who started it.
    if (!user || user.id !== saved.userId || c.req.query("state") !== saved.state) return c.redirect("/?google=state_error");
    const code = c.req.query("code");
    if (!code) return c.redirect("/?google=denied");

    let grant;
    try {
      grant = await deps.google.exchangeCalendarCode({ clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, code, codeVerifier: saved.verifier, redirectUri: new URL("/auth/google/calendar/callback", c.req.url).toString() });
    } catch (err) {
      console.error("calendar grant failed", err);
      return c.redirect("/?google=grant_error");
    }
    const values = {
      googleEmail: grant.email,
      refreshTokenEnc: await seal(grant.refreshToken, GOOGLE_TOKEN_KEY),
      accessTokenEnc: await seal(grant.accessToken, GOOGLE_TOKEN_KEY),
      accessExpiresAt: new Date(Date.now() + grant.expiresIn * 1000).toISOString(),
      syncToken: null, lastError: null,
    };
    const [conn] = await db
      .insert(googleConnections)
      .values({ id: crypto.randomUUID(), userId: user.id, calendarId: "primary", ...values })
      .onConflictDoUpdate({ target: [googleConnections.userId, googleConnections.calendarId], set: values })
      .returning();
    try { await syncConnection(db, c.env, deps.google, conn!); } catch { /* error is stored on the connection */ }
    return c.redirect("/?google=connected");
  });

  return r;
}

/** /api/google — status, manual sync, disconnect. */
export function googleApiRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    const [conn] = await getDb(c.env.DB).select().from(googleConnections).where(eq(googleConnections.userId, c.get("user").id)).limit(1);
    if (!conn) return c.json({ connected: false, configured: Boolean(c.env.GOOGLE_TOKEN_KEY) });
    return c.json({ connected: true, configured: true, google_email: conn.googleEmail, calendar_id: conn.calendarId, last_synced_at: conn.lastSyncedAt, last_error: conn.lastError });
  });

  r.post("/sync", async (c) => {
    const db = getDb(c.env.DB);
    const [conn] = await db.select().from(googleConnections).where(eq(googleConnections.userId, c.get("user").id)).limit(1);
    if (!conn) return c.json({ error: "not_connected" }, 404);
    try {
      return c.json(await syncConnection(db, c.env, deps.google, conn));
    } catch {
      const [after] = await db.select({ lastError: googleConnections.lastError }).from(googleConnections).where(eq(googleConnections.id, conn.id));
      return c.json({ error: "sync_failed", message: after?.lastError }, 502);
    }
  });

  // Disconnect: revoke at Google, forget the tokens, and remove the mirrored events.
  r.delete("/", async (c) => {
    if (c.get("auth").kind !== "session") return c.json({ error: "session_required" }, 403);
    const db = getDb(c.env.DB);
    const [conn] = await db.select().from(googleConnections).where(eq(googleConnections.userId, c.get("user").id)).limit(1);
    if (!conn) return c.json({ error: "not_connected" }, 404);
    try { await deps.google.revoke(await open(conn.refreshTokenEnc, c.env.GOOGLE_TOKEN_KEY)); } catch (err) { console.error("revoke failed", err); }
    const removed = await db.delete(events).where(and(eq(events.connectionId, conn.id), eq(events.ownerId, conn.userId))).returning({ id: events.id });
    await db.delete(googleConnections).where(eq(googleConnections.id, conn.id));
    return c.json({ disconnected: true, removed_events: removed.length });
  });

  return r;
}
