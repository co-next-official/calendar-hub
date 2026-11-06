import { Hono } from "hono";
import { exchangeCode } from "./auth/google";
import { authRoutes, meRoutes, requireUser } from "./auth/routes";
import type { AppEnv, Deps } from "./env";
import { eventRoutes, importRoutes } from "./events/routes";

export function createApp(deps: Deps = { exchangeCode }) {
  const app = new Hono<AppEnv>();

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/auth", authRoutes(deps));

  app.use("/api/*", requireUser);
  app.route("/api/me", meRoutes());
  app.route("/api/events", eventRoutes());
  app.route("/api/import", importRoutes());

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  // Everything else is the static UI.
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}

export default createApp();
