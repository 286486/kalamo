import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

const post = (token?: string) =>
  exports.default.fetch("http://kalamo/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });

it("rejects a request without a known dev token with PERMISSION_DENIED", async () => {
  for (const token of [undefined, "nope"]) {
    const res = await post(token);
    expect(res.status).toBe(401);
    const body = await res.json<{ error: { data: { code: string; hint: string } } }>();
    expect(body.error.data.code).toBe("PERMISSION_DENIED");
    expect(body.error.data.hint).toMatch(/Bearer/);
  }
});

it("accepts a known dev token", async () => {
  const res = await post("dev-token-a");
  expect(res.status).not.toBe(401);
});
