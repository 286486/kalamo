// The landing page Worker kalamo-site (#185), under a local `wrangler dev` of site/wrangler.jsonc:
// the page at / byte for byte, a 404 for every other path, and a config with nothing but assets.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";

const page = readFileSync("site/public/index.html");
let port = 0;
let server: ChildProcess | undefined;
let state = "";

/** A request with the path sent as written (no URL normalisation) and no redirect following. */
function send(path: string, method = "GET"): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  port = await freePort();
  state = mkdtempSync(join(tmpdir(), "kalamo-site-"));
  server = spawn(
    "wrangler",
    ["dev", "-c", "site/wrangler.jsonc", "--port", String(port), "--persist-to", state],
    { detached: true, stdio: "ignore" },
  );
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error("wrangler dev exited");
    try {
      if ((await send("/")).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("wrangler dev did not answer in 30 s");
}, 30_000);

afterAll(() => {
  try {
    if (server?.pid) process.kill(-server.pid, "SIGTERM");
  } catch {} // already exited
  rmSync(state, { recursive: true, force: true });
});

describe("kalamo-site", () => {
  // /%2e%2e/ is a dot segment, which resolves to / as a browser would; it reaches nothing else.
  it("serves the committed page at /, byte for byte, with or without a query", async () => {
    for (const path of ["/", "/?utm=x", "/%2e%2e/"]) {
      const res = await send(path);
      expect(res.status, path).toBe(200);
      expect(res.body.equals(page), path).toBe(true);
    }
  });

  it("answers 404, not a redirect, on every other path", async () => {
    const paths = [
      "/index.html",
      "/index",
      "/_redirects",
      "/__not_found",
      "/wrangler.jsonc",
      "/site/index.html",
      "/favicon.ico",
      "/robots.txt",
      "/mcp",
      "/mcp/",
      "/app",
      "/app/",
      "/ns/svg",
      "/api/x",
      "/auth/github/callback",
      "/authorize",
      "/oauth/token",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/a/b/c",
      "//",
    ];
    const statuses = await Promise.all(paths.map(async (p) => [p, (await send(p)).status]));
    expect(Object.fromEntries(statuses)).toEqual(Object.fromEntries(paths.map((p) => [p, 404])));
  });

  it("never accepts a POST to /mcp", async () => {
    expect([404, 405]).toContain((await send("/mcp", "POST")).status);
  });

  it("is configured as assets only: no script, route, binding or public URL", () => {
    const config = experimental_readRawConfig({ config: "site/wrangler.jsonc" }).rawConfig;
    for (const key of [
      "main",
      "routes",
      "route",
      "vars",
      "d1_databases",
      "r2_buckets",
      "kv_namespaces",
      "durable_objects",
      "services",
      "migrations",
    ])
      expect(config, key).not.toHaveProperty(key);
    expect(config.assets).not.toHaveProperty("run_worker_first");
    expect(config).toMatchObject({ name: "kalamo-site", workers_dev: false, preview_urls: false });
  });

  it("uploads nothing but the page and its _redirects", () => {
    expect(readdirSync("site/public").sort()).toEqual(["_redirects", "index.html"]);
  });
});
