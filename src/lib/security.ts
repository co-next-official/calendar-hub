import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

type LimiterName = "AUTH_LIMITER" | "GUEST_LIMITER" | "API_LIMITER";

/**
 * Workers Rate Limiting binding (see wrangler.jsonc `ratelimits`). Skipped when the binding is absent.
 * Counts are per Cloudflare location and approximate; this is abuse protection, not an exact quota.
 */
export function rateLimit(name: LimiterName, key: (c: Context<AppEnv>) => string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const limiter = c.env[name];
    if (limiter) {
      const { success } = await limiter.limit({ key: `${name}:${key(c)}` });
      if (!success) return c.json({ error: "rate_limited" }, 429, { "retry-after": "60" });
    }
    await next();
  };
}

export const clientIp = (c: Context<AppEnv>) => c.req.header("cf-connecting-ip") ?? "local";

/** Headers for Worker-generated responses. Static files get theirs from public/_headers. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
};
