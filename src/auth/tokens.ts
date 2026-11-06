import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getDb, type Db } from "../db/events";
import { apiAudit, apiTokens, users, type ApiToken, type User } from "../db/schema";
import type { AppEnv } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";

export const TOKEN_PREFIX = "chk_";
const MAX_ACTIVE_TOKENS = 20;

export async function findToken(db: Db, raw: string): Promise<{ token: ApiToken; user: User } | null> {
  if (!raw.startsWith(TOKEN_PREFIX) || raw.length > 128) return null;
  const [row] = await db
    .select({ token: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, await sha256Hex(raw)), isNull(apiTokens.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (row.token.expiresAt && row.token.expiresAt <= new Date().toISOString()) return null;
  return row;
}

export async function recordTokenUse(db: Db, token: ApiToken, method: string, path: string, status: number) {
  await db.batch([
    db.update(apiTokens).set({ lastUsedAt: new Date().toISOString() }).where(eq(apiTokens.id, token.id)),
    db.insert(apiAudit).values({ userId: token.userId, tokenId: token.id, method, path: path.slice(0, 300), status }),
  ]);
}

const view = (t: ApiToken) => ({
  id: t.id, name: t.name, scopes: t.scopes.split(","), created_at: t.createdAt, last_used_at: t.lastUsedAt, expires_at: t.expiresAt, revoked_at: t.revokedAt,
});

/** Key management. Mounted behind requireSession: an API key can never mint or list keys. */
export function tokenRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => {
    const rows = await getDb(c.env.DB).select().from(apiTokens).where(eq(apiTokens.userId, c.get("user").id)).orderBy(desc(apiTokens.createdAt));
    return c.json({ tokens: rows.map(view) });
  });

  r.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 60) return c.json({ error: "invalid_name" }, 400);
    const scopes = body?.scopes === undefined ? "read" : Array.isArray(body.scopes) && body.scopes.includes("write") ? "read,write" : Array.isArray(body.scopes) && body.scopes.every((s) => s === "read") ? "read" : null;
    if (!scopes) return c.json({ error: "invalid_scopes" }, 400);
    const days = body?.expires_in_days;
    if (days !== undefined && days !== null && (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 365)) return c.json({ error: "invalid_expires_in_days" }, 400);

    const db = getDb(c.env.DB), userId = c.get("user").id;
    const active = await db.select({ id: apiTokens.id }).from(apiTokens).where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
    if (active.length >= MAX_ACTIVE_TOKENS) return c.json({ error: "too_many_tokens" }, 400);

    const raw = TOKEN_PREFIX + randomToken(32);
    const [row] = await db.insert(apiTokens).values({
      id: crypto.randomUUID(), userId, name, scopes, tokenHash: await sha256Hex(raw),
      expiresAt: typeof days === "number" ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
    }).returning();
    // The raw key is returned exactly once.
    return c.json({ ...view(row!), token: raw }, 201);
  });

  r.delete("/:id", async (c) => {
    const [row] = await getDb(c.env.DB)
      .update(apiTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(apiTokens.id, c.req.param("id")), eq(apiTokens.userId, c.get("user").id), isNull(apiTokens.revokedAt)))
      .returning();
    return row ? c.json(view(row)) : c.json({ error: "not_found" }, 404);
  });

  r.get("/audit", async (c) => {
    const rows = await getDb(c.env.DB).select().from(apiAudit).where(eq(apiAudit.userId, c.get("user").id)).orderBy(desc(apiAudit.id)).limit(100);
    return c.json({ entries: rows.map((a) => ({ token_id: a.tokenId, method: a.method, path: a.path, status: a.status, created_at: a.createdAt })) });
  });

  return r;
}
