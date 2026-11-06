import { describe, expect, it } from "vitest";
import { testApp } from "./helpers";

describe("abuse protection and headers", () => {
  it("rate-limits guest link lookups per IP", async () => {
    const t = testApp();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await t.request("/guest/api/invites/guess-" + i, { headers: { "cf-connecting-ip": "203.0.113.9" } });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    // Another IP is unaffected.
    expect((await t.request("/guest/api/invites/x", { headers: { "cf-connecting-ip": "198.51.100.1" } })).status).toBe(404);
  });

  it("sets protective headers on API responses", async () => {
    const t = testApp();
    const res = await t.request("/api/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
