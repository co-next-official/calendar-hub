// Google OpenID Connect, authorization code flow with PKCE.
import { decodeBase64url } from "../lib/crypto";

export type GoogleClaims = { sub: string; email: string; name: string; picture: string | null };

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export function buildAuthUrl(p: { clientId: string; redirectUri: string; state: string; codeChallenge: string }) {
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

/**
 * The ID token comes straight from Google's token endpoint over TLS, so per OIDC Core 3.1.3.7
 * TLS validation stands in for the signature check. iss / aud / exp / email_verified are still checked.
 */
export function parseIdToken(idToken: string, clientId: string, nowSec = Math.floor(Date.now() / 1000)): GoogleClaims {
  const payload = idToken.split(".")[1];
  if (!payload) throw new Error("malformed_id_token");
  const c = JSON.parse(decodeBase64url(payload)) as Record<string, unknown>;
  if (!ISSUERS.includes(String(c.iss))) throw new Error("bad_issuer");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) throw new Error("bad_audience");
  if (typeof c.exp !== "number" || c.exp < nowSec - 60) throw new Error("expired_id_token");
  if (typeof c.sub !== "string" || !c.sub) throw new Error("missing_sub");
  if (typeof c.email !== "string" || c.email_verified !== true) throw new Error("unverified_email");
  return {
    sub: c.sub,
    email: c.email.toLowerCase(),
    name: typeof c.name === "string" ? c.name : "",
    picture: typeof c.picture === "string" ? c.picture : null,
  };
}

export async function exchangeCode(p: { clientId: string; clientSecret: string; code: string; codeVerifier: string; redirectUri: string }): Promise<GoogleClaims> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code: p.code,
      code_verifier: p.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: p.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`token_exchange_failed_${res.status}`);
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new Error("missing_id_token");
  return parseIdToken(body.id_token, p.clientId);
}
