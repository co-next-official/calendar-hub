import { Hono } from "hono";
import { exchangeCode } from "./auth/google";
import { authRoutes, meRoutes, requireSession, requireUser } from "./auth/routes";
import { tokenRoutes } from "./auth/tokens";
import type { AppEnv, Deps, Env } from "./env";
import { getDb } from "./db/events";
import { realGoogleApi } from "./google/client";
import { googleApiRoutes, googleConnectRoutes } from "./google/routes";
import { syncAll } from "./google/sync";
import { clientIp, rateLimit, securityHeaders } from "./lib/security";
import { feedApiRoutes, feedPublicRoutes } from "./events/feed-routes";
import { eventRoutes, importRoutes } from "./events/routes";
import { groupRoutes } from "./groups/routes";
import { availabilityRoutes } from "./availability/routes";
import { guestRoutes, sharingRoutes } from "./events/sharing-routes";

export const defaultDeps: Deps = { exchangeCode, google: realGoogleApi };

export function createApp(deps: Deps = defaultDeps) {
  const app = new Hono<AppEnv>();

  app.use("/api/*", securityHeaders);
  app.use("/auth/*", securityHeaders);
  app.use("/guest/api/*", securityHeaders);
  app.use("/auth/*", rateLimit("AUTH_LIMITER", clientIp));
  app.use("/guest/api/*", rateLimit("GUEST_LIMITER", clientIp));
  app.use("/feed/*", securityHeaders);
  app.use("/feed/*", rateLimit("GUEST_LIMITER", clientIp));
  app.route("/feed", feedPublicRoutes());

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/auth/google/calendar", googleConnectRoutes(deps));
  app.route("/auth", authRoutes(deps));
  app.route("/guest/api", guestRoutes());

  app.use("/api/*", requireUser);
  app.use("/api/*", rateLimit("API_LIMITER", (c) => (c.get("auth").kind === "token" ? `t:${(c.get("auth") as { tokenId: string }).tokenId}` : `u:${c.get("user").id}`)));
  app.route("/api/me", meRoutes());
  app.use("/api/tokens/*", requireSession);
  app.use("/api/tokens", requireSession);
  app.route("/api/tokens", tokenRoutes());
  app.route("/api/events", eventRoutes());
  app.route("/api/events", sharingRoutes());
  app.route("/api/import", importRoutes());
  app.route("/api/groups", groupRoutes());
  app.route("/api/availability", availabilityRoutes());
  app.route("/api/google", googleApiRoutes(deps));
  app.route("/api/feed", feedApiRoutes());

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  // Everything else is the static UI.
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  // Cron trigger (wrangler.jsonc): keep Google Calendar mirrors fresh.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncAll(getDb(env.DB), env, defaultDeps.google));
  },
} satisfies ExportedHandler<Env>;
