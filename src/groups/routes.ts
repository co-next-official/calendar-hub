import { and, asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { getDb, type Db } from "../db/events";
import { groupMembers, groups, users, type User } from "../db/schema";
import type { AppEnv } from "../env";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const MAX_GROUPS_OWNED = 50;
const MAX_MEMBERS = 100;

/** The caller's membership row in a group, if active. Non-members get null (and callers answer 404). */
export async function activeMembership(db: Db, groupId: string, userId: string) {
  const [m] = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId), eq(groupMembers.status, "active")))
    .limit(1);
  return m ?? null;
}

/** Ids of groups where the user is an active member. */
export async function activeGroupIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.select({ id: groupMembers.groupId }).from(groupMembers).where(and(eq(groupMembers.userId, userId), eq(groupMembers.status, "active")));
  return rows.map((r) => r.id);
}

/** Links pending email invitations to the user account (called on login and before listing invitations). */
export async function linkInvitations(db: Db, user: User) {
  await db.update(groupMembers).set({ userId: user.id }).where(and(eq(groupMembers.email, user.email.toLowerCase()), eq(groupMembers.status, "invited")));
}

async function groupView(db: Db, groupId: string, viewerId: string) {
  const [g] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  if (!g) return null;
  const members = await db
    .select({ id: groupMembers.id, email: groupMembers.email, role: groupMembers.role, status: groupMembers.status, name: users.name, avatarUrl: users.avatarUrl, userId: groupMembers.userId })
    .from(groupMembers)
    .leftJoin(users, eq(users.id, groupMembers.userId))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(groupMembers.createdAt));
  return {
    id: g.id,
    name: g.name,
    is_owner: g.ownerId === viewerId,
    members: members.map((m) => ({
      id: m.id, email: m.email, role: m.role, status: m.status, name: m.status === "active" ? m.name ?? "" : "", avatar_url: m.status === "active" ? m.avatarUrl : null, is_me: m.userId === viewerId,
    })),
  };
}

export function groupRoutes() {
  const r = new Hono<AppEnv>();

  // Inviting people and joining groups involves other humans: browser session only, never an API key.
  r.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.get("auth").kind !== "session") return c.json({ error: "session_required" }, 403);
    await next();
  });

  r.get("/", async (c) => {
    const db = getDb(c.env.DB), user = c.get("user");
    const ids = await activeGroupIds(db, user.id);
    const list = ids.length ? await db.select().from(groups).where(inArray(groups.id, ids)).orderBy(asc(groups.name)) : [];
    return c.json({ groups: list.map((g) => ({ id: g.id, name: g.name, is_owner: g.ownerId === user.id })) });
  });

  r.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 60) return c.json({ error: "invalid_name" }, 400);
    const db = getDb(c.env.DB), user = c.get("user");
    const owned = await db.select({ id: groups.id }).from(groups).where(eq(groups.ownerId, user.id));
    if (owned.length >= MAX_GROUPS_OWNED) return c.json({ error: "too_many_groups" }, 400);
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(groups).values({ id, ownerId: user.id, name }),
      db.insert(groupMembers).values({ id: crypto.randomUUID(), groupId: id, email: user.email.toLowerCase(), userId: user.id, role: "owner", status: "active" }),
    ]);
    return c.json(await groupView(db, id, user.id), 201);
  });

  // Invitations addressed to me (declared before /:id so it is not captured by it).
  r.get("/invitations", async (c) => {
    const db = getDb(c.env.DB), user = c.get("user");
    await linkInvitations(db, user);
    const rows = await db
      .select({ memberId: groupMembers.id, groupId: groups.id, name: groups.name, inviter: users.name, inviterEmail: users.email })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .leftJoin(users, eq(users.id, groupMembers.invitedBy))
      .where(and(eq(groupMembers.userId, user.id), eq(groupMembers.status, "invited")));
    return c.json({ invitations: rows.map((i) => ({ group_id: i.groupId, group_name: i.name, invited_by: i.inviter || i.inviterEmail || "" })) });
  });

  r.get("/:id", async (c) => {
    const db = getDb(c.env.DB), user = c.get("user"), id = c.req.param("id");
    if (!(await activeMembership(db, id, user.id))) return c.json({ error: "not_found" }, 404);
    return c.json(await groupView(db, id, user.id));
  });

  r.patch("/:id", async (c) => {
    const db = getDb(c.env.DB), user = c.get("user"), id = c.req.param("id");
    const m = await activeMembership(db, id, user.id);
    if (!m) return c.json({ error: "not_found" }, 404);
    if (m.role !== "owner") return c.json({ error: "owner_only" }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 60) return c.json({ error: "invalid_name" }, 400);
    await db.update(groups).set({ name }).where(eq(groups.id, id));
    return c.json(await groupView(db, id, user.id));
  });

  r.delete("/:id", async (c) => {
    const db = getDb(c.env.DB), user = c.get("user"), id = c.req.param("id");
    const m = await activeMembership(db, id, user.id);
    if (!m) return c.json({ error: "not_found" }, 404);
    if (m.role !== "owner") return c.json({ error: "owner_only" }, 403);
    await db.delete(groups).where(eq(groups.id, id));
    return c.json({ deleted: true });
  });

  r.post("/:id/members", async (c) => {
    const db = getDb(c.env.DB), user = c.get("user"), id = c.req.param("id");
    const m = await activeMembership(db, id, user.id);
    if (!m) return c.json({ error: "not_found" }, 404);
    if (m.role !== "owner") return c.json({ error: "owner_only" }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) return c.json({ error: "invalid_email" }, 400);
    const existing = await db.select({ id: groupMembers.id, email: groupMembers.email }).from(groupMembers).where(eq(groupMembers.groupId, id));
    if (existing.some((x) => x.email === email)) return c.json({ error: "already_member" }, 409);
    if (existing.length >= MAX_MEMBERS) return c.json({ error: "too_many_members" }, 400);
    const [invitee] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    await db.insert(groupMembers).values({ id: crypto.randomUUID(), groupId: id, email, userId: invitee?.id ?? null, role: "member", status: "invited", invitedBy: user.id });
    return c.json(await groupView(db, id, user.id), 201);
  });

  r.delete("/:id/members/:memberId", async (c) => {
    const db = getDb(c.env.DB), user = c.get("user"), id = c.req.param("id");
    const m = await activeMembership(db, id, user.id);
    if (!m) return c.json({ error: "not_found" }, 404);
    const [target] = await db.select().from(groupMembers).where(and(eq(groupMembers.id, c.req.param("memberId")), eq(groupMembers.groupId, id))).limit(1);
    if (!target) return c.json({ error: "not_found" }, 404);
    if (target.role === "owner") return c.json({ error: "cannot_remove_owner" }, 400);
    // Owners can remove anyone; members can only remove themselves (= leave).
    if (m.role !== "owner" && target.userId !== user.id) return c.json({ error: "owner_only" }, 403);
    await db.delete(groupMembers).where(eq(groupMembers.id, target.id));
    return c.json({ removed: true });
  });

  r.post("/:id/accept", async (c) => {
    const db = getDb(c.env.DB), user = c.get("user"), id = c.req.param("id");
    await linkInvitations(db, user);
    const [row] = await db
      .update(groupMembers)
      .set({ status: "active" })
      .where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, user.id), eq(groupMembers.status, "invited")))
      .returning();
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(await groupView(db, id, user.id));
  });

  r.post("/:id/decline", async (c) => {
    const db = getDb(c.env.DB), user = c.get("user"), id = c.req.param("id");
    const rows = await db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, user.id), eq(groupMembers.status, "invited")))
      .returning({ id: groupMembers.id });
    return rows.length ? c.json({ declined: true }) : c.json({ error: "not_found" }, 404);
  });

  return r;
}
