import { beforeEach, describe, expect, it } from "vitest";
import { login, resetDb, testApp } from "./helpers";

beforeEach(resetDb);

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, any> }>;

async function setup() {
  const t = testApp();
  const as = async (sub: string, email: string): Promise<Call> => {
    const { cookie } = await login(t, { sub, email });
    return async (method, path, body) => {
      const res = await t.request(path, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
  };
  return { t, as };
}

describe("/api/groups", () => {
  it("runs the invite → accept flow and only shows groups to active members", async () => {
    const { as } = await setup();
    const alice = await as("a", "alice@example.com");
    const bob = await as("b", "bob@example.com");
    const carol = await as("c", "carol@example.com");

    const { body: g } = await alice("POST", "/api/groups", { name: "家族" });
    expect(g.members).toHaveLength(1);
    expect(g.is_owner).toBe(true);

    expect((await alice("POST", `/api/groups/${g.id}/members`, { email: "Bob@Example.com" })).status).toBe(201);
    expect((await alice("POST", `/api/groups/${g.id}/members`, { email: "bob@example.com" })).status).toBe(409);

    // Invited but not accepted: cannot see the group yet.
    expect((await bob("GET", `/api/groups/${g.id}`)).status).toBe(404);
    expect((await bob("GET", "/api/groups")).body.groups).toEqual([]);
    expect((await bob("GET", "/api/groups/invitations")).body.invitations).toMatchObject([{ group_id: g.id, group_name: "家族" }]);

    expect((await bob("POST", `/api/groups/${g.id}/accept`)).status).toBe(200);
    expect((await bob("GET", "/api/groups")).body.groups).toMatchObject([{ id: g.id, is_owner: false }]);

    // Outsiders see nothing and cannot accept someone else's invitation.
    expect((await carol("GET", `/api/groups/${g.id}`)).status).toBe(404);
    expect((await carol("POST", `/api/groups/${g.id}/accept`)).status).toBe(404);
  });

  it("links invitations sent before the invitee ever logged in", async () => {
    const { as } = await setup();
    const alice = await as("a", "alice@example.com");
    const { body: g } = await alice("POST", "/api/groups", { name: "友達" });
    await alice("POST", `/api/groups/${g.id}/members`, { email: "dave@example.com" });
    const dave = await as("d", "dave@example.com");
    expect((await dave("GET", "/api/groups/invitations")).body.invitations).toHaveLength(1);
    expect((await dave("POST", `/api/groups/${g.id}/decline`)).status).toBe(200);
    expect((await alice("GET", `/api/groups/${g.id}`)).body.members).toHaveLength(1);
  });

  it("restricts management to the owner and lets members leave", async () => {
    const { as } = await setup();
    const alice = await as("a", "alice@example.com");
    const bob = await as("b", "bob@example.com");
    const { body: g } = await alice("POST", "/api/groups", { name: "チーム" });
    await alice("POST", `/api/groups/${g.id}/members`, { email: "bob@example.com" });
    await bob("POST", `/api/groups/${g.id}/accept`);

    expect((await bob("POST", `/api/groups/${g.id}/members`, { email: "x@example.com" })).status).toBe(403);
    expect((await bob("PATCH", `/api/groups/${g.id}`, { name: "乗っ取り" })).status).toBe(403);
    expect((await bob("DELETE", `/api/groups/${g.id}`)).status).toBe(403);
    const owner = g.members[0];
    expect((await bob("DELETE", `/api/groups/${g.id}/members/${owner.id}`)).status).toBe(400);

    const me = (await bob("GET", `/api/groups/${g.id}`)).body.members.find((m: any) => m.is_me);
    expect((await bob("DELETE", `/api/groups/${g.id}/members/${me.id}`)).status).toBe(200);
    expect((await bob("GET", `/api/groups/${g.id}`)).status).toBe(404);

    expect((await alice("DELETE", `/api/groups/${g.id}`)).status).toBe(200);
    expect((await alice("GET", "/api/groups")).body.groups).toEqual([]);
  });

  it("does not reveal invited people's names before they accept", async () => {
    const { as } = await setup();
    const alice = await as("a", "alice@example.com");
    await as("b", "bob@example.com");
    const { body: g } = await alice("POST", "/api/groups", { name: "g" });
    const { body } = await alice("POST", `/api/groups/${g.id}/members`, { email: "bob@example.com" });
    expect(body.members.find((m: any) => m.email === "bob@example.com")).toMatchObject({ status: "invited", name: "" });
  });
});

describe("groups via API key", () => {
  it("allows reading but not managing groups with a key", async () => {
    const { t, as } = await setup();
    const alice = await as("a", "alice@example.com");
    const { body: g } = await alice("POST", "/api/groups", { name: "g" });
    const { body: key } = await alice("POST", "/api/tokens", { name: "ai", scopes: ["read", "write"] });
    const h = { authorization: `Bearer ${key.token}`, "content-type": "application/json" };
    expect((await t.request("/api/groups", { headers: h })).status).toBe(200);
    const invite = await t.request(`/api/groups/${g.id}/members`, { method: "POST", headers: h, body: JSON.stringify({ email: "x@example.com" }) });
    expect(invite.status).toBe(403);
  });
});
