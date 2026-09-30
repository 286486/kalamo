// The landing page Worker kalamo-site (#185), under a local `wrangler dev` of site/wrangler.jsonc:
// the page at / byte for byte, its og:image at /og.png, a 404 for every other path (or a 307 to
// /index.html, which 404s), and a config with nothing but assets.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import { startServer } from "./wrangler.ts";

const page = readFileSync("site/public/index.html");
let port = 0;
let server: { stop(): void } | undefined;
let state = "";

/** A request with the path sent as written (no URL normalisation) and no redirect following. node:http
 * sends no Accept-Encoding, so the body arrives uncompressed and compares byte for byte. */
function send(
  path: string,
  method = "GET",
): Promise<{ status: number; location?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          location: res.headers.location,
          body: Buffer.concat(chunks),
        }),
      );
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
  server = await startServer(port, state, {
    args: ["-c", "site/wrangler.jsonc"],
    ready: "/",
    seconds: 25,
  });
}, 30_000);

afterAll(() => {
  server?.stop();
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
  }, 30_000);

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
  }, 30_000);

  // _redirects matches the raw path, but the asset worker looks assets up by the decoded path with
  // repeated slashes merged, and answers 307 to that canonical path when the two differ. So an
  // encoded or doubled-slash /index.html is either a 404 or a relative 307 to /index.html, which
  // then 404s: never the page, and never another origin.
  it("answers an encoded or doubled-slash /index.html with a 404, or a 307 to one", async () => {
    for (const path of [
      "/INDEX.HTML",
      "/index.html/",
      "/index.html?x",
      "/./index.html",
      "/%2e/index.html",
      "/%69ndex.html",
      "/index%2ehtml",
      "/index.htm%6c",
      "//index.html",
      "/%2Findex.html",
      "//evil.example/",
      "/%2Fevil.example/",
    ]) {
      const res = await send(path);
      expect(res.body.length, path).toBe(0);
      if (res.status === 307) expect(res.location, path).toBe("/index.html");
      else expect(res.status, path).toBe(404);
    }
    const next = await send("/index.html");
    expect([next.status, next.body.length]).toEqual([404, 0]);
  }, 30_000);

  it("never accepts a POST to /mcp", async () => {
    expect([404, 405]).toContain((await send("/mcp", "POST")).status);
  }, 30_000);

  it("is configured as assets only: no script, route, binding or public URL", () => {
    const config = experimental_readRawConfig({ config: "site/wrangler.jsonc" }).rawConfig;
    expect(Object.keys(config).sort()).toEqual([
      "$schema",
      "assets",
      "compatibility_date",
      "name",
      "preview_urls",
      "workers_dev",
    ]);
    expect(Object.keys(config.assets ?? {}).sort()).toEqual([
      "directory",
      "html_handling",
      "not_found_handling",
    ]);
    expect(config).toMatchObject({ name: "kalamo-site", workers_dev: false, preview_urls: false });
  });

  it("serves the social preview image the page names in og:image", async () => {
    const res = await send("/og.png");
    expect(res.status).toBe(200);
    expect(res.body.equals(readFileSync("site/public/og.png"))).toBe(true);
    expect(page.toString()).toContain('<meta property="og:image" content="https://kalamo.cc/og.png">');
  }, 30_000);

  it("uploads nothing but the page, its preview image and its _redirects", () => {
    expect(readdirSync("site/public").sort()).toEqual(["_redirects", "index.html", "og.png"]);
  });
});
