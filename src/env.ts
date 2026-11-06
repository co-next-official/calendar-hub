import type { GoogleClaims } from "./auth/google";
import type { User } from "./db/schema";

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  ALLOWED_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
};

/** External calls the app depends on, injectable for tests. */
export type Deps = {
  exchangeCode: (p: { clientId: string; clientSecret: string; code: string; codeVerifier: string; redirectUri: string }) => Promise<GoogleClaims>;
};

export type AppEnv = { Bindings: Env; Variables: { user: User } };
