import { env } from "cloudflare:test";
import { createApp } from "../src/index";
import type { GoogleClaims } from "../src/auth/google";
import type { GoogleApi } from "../src/google/client";

/** A Google Calendar API that does nothing unless a test overrides parts of it. */
export function fakeGoogle(overrides: Partial<GoogleApi> = {}): GoogleApi {
  return {
    exchangeCalendarCode: async () => { throw new Error("not faked"); },
    refreshAccessToken: async () => ({ accessToken: "fresh-access", expiresIn: 3600 }),
    listEvents: async () => ({ items: [] }),
    revoke: async () => {},
    ...overrides,
  };
}

export const BASE = "https://cal.example.com";

/** App whose Google token exchange returns whatever claims the test sets for a code. */
export function testApp(google: GoogleApi = fakeGoogle()) {
  const accounts = new Map<string, GoogleClaims>();
  const app = createApp({
    exchangeCode: async ({ code }) => {
      const claims = accounts.get(code);
      if (!claims) throw new Error("unknown code");
      return claims;
    },
    google,
  });
  const request = (path: string, init: RequestInit = {}) => app.request(BASE + path, init, env);
  return { app, accounts, request };
}

function cookiesOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const i = pair!.indexOf("=");
    out[pair!.slice(0, i)] = pair!.slice(i + 1);
  }
  return out;
}

/** Runs the full login flow and returns the session cookie header value. */
export async function login(t: ReturnType<typeof testApp>, claims: Partial<GoogleClaims> & { sub: string; email: string }) {
  const code = `code-${claims.sub}`;
  t.accounts.set(code, { name: "", picture: null, ...claims });
  const start = await t.request("/auth/google/login?return_to=/");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const oauthCookie = cookiesOf(start)["ch_oauth"]!;
  const cb = await t.request(`/auth/google/callback?code=${code}&state=${state}`, { headers: { cookie: `ch_oauth=${oauthCookie}` } });
  const session = cookiesOf(cb)["ch_session"];
  return { response: cb, cookie: session ? `ch_session=${session}` : "" };
}

export async function resetDb() {
  await env.DB.exec("DELETE FROM calendar_feeds; DELETE FROM google_connections; DELETE FROM event_invites; DELETE FROM event_participants; DELETE FROM group_members; DELETE FROM groups; DELETE FROM api_audit; DELETE FROM api_tokens; DELETE FROM events; DELETE FROM sessions; DELETE FROM users;");
}
