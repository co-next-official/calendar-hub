import type { GoogleClaims } from "./auth/google";
import type { GoogleApi } from "./google/client";
import type { User } from "./db/schema";

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  ALLOWED_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  /** base64 of 32 random bytes; encrypts Google OAuth tokens at rest. */
  GOOGLE_TOKEN_KEY?: string;
  AUTH_LIMITER?: RateLimit;
  GUEST_LIMITER?: RateLimit;
  API_LIMITER?: RateLimit;
};

/** External calls the app depends on, injectable for tests. */
export type Deps = {
  exchangeCode: (p: { clientId: string; clientSecret: string; code: string; codeVerifier: string; redirectUri: string }) => Promise<GoogleClaims>;
  google: GoogleApi;
};

export type AuthContext = { kind: "session" } | { kind: "token"; tokenId: string; scopes: ("read" | "write")[] };

export type AppEnv = { Bindings: Env; Variables: { user: User; auth: AuthContext } };
