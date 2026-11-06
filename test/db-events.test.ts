import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createEvent, deleteEvent, getDb, getEvent, listEvents, toFields, updateEvent } from "../src/db/events";
import { users } from "../src/db/schema";
import { validateEvent, type EventFields } from "../src/events/validate";

const db = getDb(env.DB);
const fields = (input: Record<string, unknown>): EventFields => {
  const r = validateEvent(input);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

beforeEach(async () => {
  await env.DB.exec("DELETE FROM events; DELETE FROM users;");
  await db.insert(users).values([
    { id: "alice", googleSub: "g-alice", email: "alice@example.com" },
    { id: "bob", googleSub: "g-bob", email: "bob@example.com" },
  ]);
});

describe("event repository", () => {
  it("never returns or modifies another owner's events", async () => {
    const a = await createEvent(db, "alice", fields({ title: "Alice only", all_day: true, start_date: "2026-11-10" }), { source: "web" });

    expect(await listEvents(db, "bob", { from: "2026-11-01", to: "2026-12-01" })).toEqual([]);
    expect(await getEvent(db, "bob", a.id)).toBeNull();
    expect((await updateEvent(db, "bob", a.id, a.version, { ...toFields(a), title: "hijacked" })).status).toBe("not_found");
    expect(await deleteEvent(db, "bob", a.id)).toBe(false);

    const still = await getEvent(db, "alice", a.id);
    expect(still?.title).toBe("Alice only");
  });

  it("lists events overlapping the requested range", async () => {
    await createEvent(db, "alice", fields({ title: "in", all_day: true, start_date: "2026-11-10" }), { source: "web" });
    await createEvent(db, "alice", fields({ title: "spans", all_day: true, start_date: "2026-10-30", end_date: "2026-11-02" }), { source: "web" });
    await createEvent(db, "alice", fields({ title: "timed", start_at: "2026-11-15T01:00:00Z", end_at: "2026-11-15T02:00:00Z" }), { source: "web" });
    await createEvent(db, "alice", fields({ title: "out", all_day: true, start_date: "2026-12-05" }), { source: "web" });

    const titles = (await listEvents(db, "alice", { from: "2026-11-01", to: "2026-12-01" })).map((e) => e.title);
    expect(titles.sort()).toEqual(["in", "spans", "timed"]);
    expect((await listEvents(db, "alice", { from: "2026-11-01", to: "2026-12-01", q: "TIM" })).map((e) => e.title)).toEqual(["timed"]);
  });

  it("rejects stale versions with a conflict", async () => {
    const e = await createEvent(db, "alice", fields({ title: "v1", all_day: true, start_date: "2026-11-10" }), { source: "web" });
    const first = await updateEvent(db, "alice", e.id, e.version, { ...toFields(e), title: "v2" });
    expect(first.status).toBe("ok");
    const second = await updateEvent(db, "alice", e.id, e.version, { ...toFields(e), title: "v2-from-other-tab" });
    expect(second.status).toBe("conflict");
    expect((await getEvent(db, "alice", e.id))?.title).toBe("v2");
  });

  it("enforces the time shape in the database itself", async () => {
    await expect(
      env.DB.prepare("INSERT INTO events (id, owner_id, title, all_day, start_date, end_date) VALUES ('x', 'alice', 't', 1, '2026-11-10', '2026-11-10')").run(),
    ).rejects.toThrow();
  });
});
