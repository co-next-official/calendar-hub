export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  ALLOWED_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
};

export type AppEnv = { Bindings: Env };
