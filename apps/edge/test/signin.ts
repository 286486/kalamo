import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import worker from "../src/index.ts";

export const APP_ORIGIN = "https://kalamo.test";

/** The test env in GitHub mode (ADR-0047); the pool's own env stays in dev mode. */
export const githubEnv: Env = {
  ...env,
  AUTH_MODE: "github",
  APP_ORIGIN,
  GITHUB_CLIENT_ID: "test-client",
  GITHUB_CLIENT_SECRET: "test-secret",
};

/**
 * A request to the Worker in GitHub mode; `init` carries any cookie and Origin. A path is on
 * APP_ORIGIN; a full URL goes where it names.
 */
export const hosted = (path: string, init: RequestInit = {}, e: Env = githubEnv) =>
  worker.fetch(
    new Request(new URL(path, APP_ORIGIN), init) as Parameters<typeof worker.fetch>[0],
    e,
    createExecutionContext(),
  );

/** The access token the stubbed GitHub hands out, which nothing may keep. */
export const GITHUB_TOKEN = "gho_stubbed_access_token";

/**
 * Signs a GitHub user in through the real `/auth/github` and callback, with GitHub's token and user
 * endpoints stubbed. Returns the callback's response and its session cookie as a `cookie` header.
 */
export async function signIn(user = { id: 1, login: "octocat" }, returnTo = "/") {
  const start = await hosted(`/auth/github?return=${encodeURIComponent(returnTo)}`);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const stateCookie = start.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: GITHUB_TOKEN, token_type: "bearer", scope: "" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({
        id: user.id,
        login: user.login,
        avatar_url: `https://avatars.example/${user.id}`,
      });
    }
    throw new Error(`unexpected fetch of ${url}`);
  });
  try {
    const res = await hosted(`/auth/github/callback?code=stub-code&state=${state}`, {
      headers: { cookie: stateCookie },
    });
    const session = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-kalamo_session="))
      ?.split(";")[0];
    return { res, cookie: session ?? "" };
  } finally {
    spy.mockRestore();
  }
}
