import { and, eq, gt, lt } from "drizzle-orm";
import type { Db } from "../db/events";
import { sessions, users, type User } from "../db/schema";
import type { GoogleClaims } from "./google";
import { randomToken, sha256Hex } from "../lib/crypto";

export const SESSION_COOKIE = "ch_session";
export const SESSION_TTL_SEC = 30 * 24 * 3600;

export function isEmailAllowed(email: string, allowList: string | undefined): boolean {
  const allowed = (allowList ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(email.toLowerCase());
}

/** Finds the user by Google `sub`, creating it on first login and refreshing the profile otherwise. */
export async function upsertUser(db: Db, claims: GoogleClaims): Promise<User> {
  const now = new Date().toISOString();
  const [row] = await db
    .insert(users)
    .values({ id: crypto.randomUUID(), googleSub: claims.sub, email: claims.email, name: claims.name, avatarUrl: claims.picture, lastLoginAt: now })
    .onConflictDoUpdate({ target: users.googleSub, set: { email: claims.email, avatarUrl: claims.picture, lastLoginAt: now } })
    .returning();
  return row!;
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString();
  await db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, new Date().toISOString())));
  await db.insert(sessions).values({ idHash: await sha256Hex(token), userId, expiresAt });
  return token;
}

export async function getSessionUser(db: Db, token: string | undefined): Promise<User | null> {
  if (!token || token.length > 128) return null;
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.idHash, await sha256Hex(token)), gt(sessions.expiresAt, new Date().toISOString())))
    .limit(1);
  return row?.user ?? null;
}

export async function deleteSession(db: Db, token: string | undefined) {
  if (token) await db.delete(sessions).where(eq(sessions.idHash, await sha256Hex(token)));
}
