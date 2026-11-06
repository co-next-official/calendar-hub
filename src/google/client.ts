// Thin Google Calendar API client (read-only). Injected through Deps so tests can fake it.

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export type GoogleEvent = {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
};

export type EventsPage = { items: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string; timeZone?: string };

export class SyncTokenExpired extends Error {}
export class GoogleAuthError extends Error {}

export type GoogleApi = {
  exchangeCalendarCode(p: { clientId: string; clientSecret: string; code: string; codeVerifier: string; redirectUri: string }): Promise<{ refreshToken: string; accessToken: string; expiresIn: number; email: string | null }>;
  refreshAccessToken(p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<{ accessToken: string; expiresIn: number }>;
  listEvents(p: { accessToken: string; calendarId: string; syncToken?: string; pageToken?: string; timeMin?: string }): Promise<EventsPage>;
  revoke(token: string): Promise<void>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries 429 and 5xx with exponential backoff (0.5s, 1s, 2s). */
async function fetchWithRetry(input: string, init: RequestInit, attempts = 4): Promise<Response> {
  let res: Response | undefined;
  for (let i = 0; i < attempts; i++) {
    res = await fetch(input, init);
    if (res.status !== 429 && res.status < 500) return res;
    if (i < attempts - 1) await sleep(500 * 2 ** i);
  }
  return res!;
}

function idTokenEmail(idToken: string | undefined): string | null {
  try {
    const payload = idToken?.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=")));
    return typeof json.email === "string" ? json.email : null;
  } catch {
    return null;
  }
}

export const realGoogleApi: GoogleApi = {
  async exchangeCalendarCode(p) {
    const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: p.clientId, client_secret: p.clientSecret, code: p.code, code_verifier: p.codeVerifier, grant_type: "authorization_code", redirect_uri: p.redirectUri }),
    });
    const body = (await res.json()) as Record<string, any>;
    if (!res.ok) throw new GoogleAuthError(`token exchange failed: ${res.status} ${body.error ?? ""}`);
    if (!String(body.scope ?? "").split(" ").includes(CALENDAR_SCOPE)) throw new GoogleAuthError("calendar scope was not granted");
    if (!body.refresh_token) throw new GoogleAuthError("no refresh_token (prompt=consent required)");
    return { refreshToken: body.refresh_token, accessToken: body.access_token, expiresIn: Number(body.expires_in ?? 3600), email: idTokenEmail(body.id_token) };
  },

  async refreshAccessToken(p) {
    const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: p.clientId, client_secret: p.clientSecret, refresh_token: p.refreshToken, grant_type: "refresh_token" }),
    });
    const body = (await res.json()) as Record<string, any>;
    if (res.status === 400 || res.status === 401) throw new GoogleAuthError(`refresh rejected: ${body.error ?? res.status}`);
    if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
    return { accessToken: body.access_token, expiresIn: Number(body.expires_in ?? 3600) };
  },

  async listEvents(p) {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(p.calendarId)}/events`);
    url.searchParams.set("singleEvents", "true"); // expand recurring events into instances
    url.searchParams.set("showDeleted", "true"); // so cancelled instances can be removed
    url.searchParams.set("maxResults", "250");
    if (p.syncToken) url.searchParams.set("syncToken", p.syncToken);
    else if (p.timeMin) url.searchParams.set("timeMin", p.timeMin);
    if (p.pageToken) url.searchParams.set("pageToken", p.pageToken);
    const res = await fetchWithRetry(url.toString(), { headers: { authorization: `Bearer ${p.accessToken}` } });
    if (res.status === 410) throw new SyncTokenExpired("sync token expired");
    if (res.status === 401 || res.status === 403) throw new GoogleAuthError(`calendar access denied: ${res.status}`);
    if (!res.ok) throw new Error(`events.list failed: ${res.status}`);
    return (await res.json()) as EventsPage;
  },

  async revoke(token) {
    await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
  },
};
