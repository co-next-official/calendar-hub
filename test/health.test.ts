import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("responds to the health check", async () => {
  const res = await SELF.fetch("https://example.com/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it("returns JSON 404 for unknown API routes", async () => {
  const res = await SELF.fetch("https://example.com/api/nope");
  expect(res.status).toBe(404);
});
