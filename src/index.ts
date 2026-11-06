import { Hono } from "hono";
import type { AppEnv } from "./env";

export const app = new Hono<AppEnv>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

// Everything else is the static UI.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
