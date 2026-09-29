import type { ErrorData } from "@kalamo/core";
import { newId } from "@kalamo/core";

/** Who a request acts as (ADR-0047): its User, the Actor its edits record, and what it may do. */
export interface Principal {
  userId: string;
  actor: string;
  access: "write" | "read";
}

/** Dev mode's one browser User, whose Actor keeps ADR-0010's `user`. */
const LOCAL: Principal = { userId: "local", actor: "user", access: "write" };

/**
 * The headers that carry the Worker's Actor, User and Role to the Document DO on a WebSocket
 * upgrade; a client's copies are replaced.
 */
export const ACTOR_HEADER = "x-kalamo-actor";
export const USER_HEADER = "x-kalamo-user";
export const ROLE_HEADER = "x-kalamo-role";
/** GitHub mode: the most sockets the Document DO keeps open (ADR-0048); absent means no limit. */
export const CONNECTION_LIMIT_HEADER = "x-kalamo-connection-limit";

const SESSION_COOKIE = "__Host-kalamo_session";
const STATE_COOKIE = "__Host-kalamo_oauth";
const DAY = 86_400_000;
/** A session ends after this long unused; its last-seen time moves at most once a day. */
const IDLE = 30 * DAY;

/** Anything but `dev` is GitHub mode, so a deploy that sets no mode is never open. */
export const githubMode = (env: Env) => env.AUTH_MODE !== "dev";

/** GitHub mode without what it needs answers every request 500, rather than serve without auth. */
export const misconfigured = (env: Env) =>
  githubMode(env) &&
  !(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.APP_ORIGIN && env.DB && env.OAUTH_KV);

/**
 * GitHub mode refuses a cookie-authenticated write or WebSocket upgrade from another site's page
 * (CSRF, cross-site WebSocket hijacking). `/mcp` and OAuth's own endpoints never reach this check.
 */
export const crossOrigin = (request: Request, env: Env) =>
  githubMode(env) &&
  (!["GET", "HEAD"].includes(request.method) || request.headers.get("upgrade") === "websocket") &&
  request.headers.get("origin") !== env.APP_ORIGIN;

/** The Principal of a browser request, or of dev mode's `/mcp`, or null: one function per auth mode. */
export const authenticate = (request: Request, env: Env): Promise<Principal | null> =>
  (githubMode(env) ? github : dev)(request, env);

/** Dev mode: an MCP client by its dev token; every browser is the local User. */
async function dev(request: Request, env: Env) {
  return isMcp(request) ? devPrincipal(request, env) : LOCAL;
}

/** GitHub mode: a browser by its session. `/mcp` takes its Principal from the OAuth token. */
async function github(request: Request, env: Env) {
  const user = await sessionUser(request, env);
  return user && { userId: user.id, actor: `user_${user.id}`, access: "write" as const };
}

const isMcp = (request: Request) => new URL(request.url).pathname === "/mcp";

function devPrincipal(request: Request, env: Env): Principal | null {
  const actor = actorFor(request, env.DEV_TOKENS ?? "");
  return actor ? { ...LOCAL, actor } : null;
}

/** Resolves the Agent Actor for a request from `Authorization: Bearer <dev token>`, or null. */
function actorFor(request: Request, devTokens: string): string | null {
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  for (const pair of devTokens.split(",")) {
    const [t, actor] = pair.split("=");
    if (t?.trim() === token && actor) return actor.trim();
  }
  return null;
}

export interface User {
  id: string;
  login: string;
  avatarUrl: string | null;
}

/** The signed-in User of an unexpired session, sliding its last-seen time at most once a day. */
export async function sessionUser(request: Request, env: Env): Promise<User | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.login, u.avatar_url AS avatarUrl, s.last_seen_at AS lastSeen
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  )
    .bind(hash)
    .first<User & { lastSeen: string }>();
  if (!row) return null;
  const idle = Date.now() - Date.parse(row.lastSeen);
  if (idle > IDLE) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    return null;
  }
  if (idle > DAY) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
      .bind(new Date().toISOString(), hash)
      .run();
  }
  return { id: row.id, login: row.login, avatarUrl: row.avatarUrl };
}

/** `/auth/*` and `/api/me`, or null for any other path. */
export function authRoute(request: Request, env: Env): Promise<Response> | null {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /api/me") return me(request, env);
  if (!url.pathname.startsWith("/auth/")) return null;
  if (githubMode(env)) {
    if (route === "GET /auth/github") return Promise.resolve(signIn(env, url));
    if (route === "GET /auth/github/callback") return callback(request, env, url);
    if (route === "POST /auth/signout") return signOut(request, env);
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

async function me(request: Request, env: Env) {
  if (!githubMode(env)) {
    return Response.json({ userId: LOCAL.userId, login: "local", avatarUrl: null, mode: "dev" });
  }
  const user = await sessionUser(request, env);
  if (!user) return signInRequired();
  return Response.json({
    userId: user.id,
    login: user.login,
    avatarUrl: user.avatarUrl,
    mode: "github",
  });
}

/** Sends the browser to GitHub with a fresh `state`, kept with the return path in a cookie. */
function signIn(env: Env, url: URL) {
  const state = hex(crypto.getRandomValues(new Uint8Array(16)));
  const back = encodeURIComponent(returnPath(url.searchParams.get("return")));
  // No `scope`: the public profile is all Kalamo reads.
  const github = new URL("https://github.com/login/oauth/authorize");
  github.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: callbackUrl(env),
    state,
  }).toString();
  return new Response(null, {
    status: 302,
    headers: { location: github.href, "set-cookie": cookie(STATE_COOKIE, `${state}|${back}`, 600) },
  });
}

/**
 * GitHub's redirect back: checks `state`, reads the GitHub user, upserts the User by GitHub id with
 * its `user` Actor, and starts a session. The GitHub access token never leaves this call.
 */
async function callback(request: Request, env: Env, url: URL) {
  const [state, back] = (readCookie(request, STATE_COOKIE) ?? "").split("|");
  const code = url.searchParams.get("code");
  const clear = cookie(STATE_COOKIE, "", 0);
  if (!state || state !== url.searchParams.get("state") || !code) {
    return new Response(
      "Sign-in failed: this link is stale or was not started here. Sign in again.",
      {
        status: 400,
        headers: { "set-cookie": clear },
      },
    );
  }
  const gh = await githubUser(env, code);
  if (!gh) {
    return new Response("GitHub did not complete the sign-in. Sign in again.", {
      status: 502,
      headers: { "set-cookie": clear },
    });
  }
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, github_id, login, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url`,
    ).bind(newId(), gh.id, gh.login, gh.avatarUrl, now),
    env.DB.prepare(
      `INSERT INTO actors (id, user_id, kind, name, created_at)
       SELECT 'user_' || id, id, 'user', login, ? FROM users WHERE github_id = ?
       ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
    ).bind(now, gh.id),
    env.DB.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at)
       SELECT ?, id, ?, ? FROM users WHERE github_id = ?`,
    ).bind(await sha256(token), now, now, gh.id),
  ]);
  const headers = new Headers({ location: returnPath(decodeURIComponent(back ?? "")) });
  headers.append("set-cookie", clear);
  // The server ends an idle session; the cookie only needs to outlive it (400 days is Chrome's cap).
  headers.append("set-cookie", cookie(SESSION_COOKIE, token, (400 * DAY) / 1000));
  return new Response(null, { status: 302, headers });
}

/** Exchanges the code and reads the GitHub user, or null when GitHub refuses either. */
async function githubUser(env: Env, code: string) {
  const exchange = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(env),
    }),
  });
  const { access_token } = await exchange.json<{ access_token?: string }>();
  if (!access_token) return null;
  const res = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "kalamo",
    },
  });
  if (!res.ok) return null;
  const { id, login, avatar_url } = await res.json<{
    id?: number;
    login?: string;
    avatar_url?: string;
  }>();
  if (typeof id !== "number" || typeof login !== "string") return null;
  return { id, login, avatarUrl: avatar_url ?? null };
}

/** Deletes the session, so its cookie stops working at once, and goes back to the list. */
async function signOut(request: Request, env: Env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await sha256(token))
      .run();
  }
  return new Response(null, {
    status: 303,
    headers: { location: "/", "set-cookie": cookie(SESSION_COOKIE, "", 0) },
  });
}

const callbackUrl = (env: Env) => `${env.APP_ORIGIN}/auth/github/callback`;

/** A same-site path to come back to; anything else, such as `//evil.example`, is the list. */
const returnPath = (path: string | null) => (path && /^\/(?![/\\])/.test(path) ? path : "/");

const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;

const readCookie = (request: Request, name: string) =>
  request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1] || null;

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const sha256 = async (text: string) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

const denied = (status: number, message: string, hint: string) =>
  Response.json({ code: "PERMISSION_DENIED", message, hint } satisfies ErrorData, { status });

export const signInRequired = () =>
  denied(401, "Not signed in.", "Sign in with GitHub at /auth/github, then retry.");

export const foreignOrigin = () =>
  denied(
    403,
    "This request did not come from Kalamo's own pages.",
    "Use Kalamo from its own address.",
  );

export const permissionDenied = () =>
  Response.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: "PERMISSION_DENIED",
        data: {
          code: "PERMISSION_DENIED",
          hint: "Send Authorization: Bearer <dev token> with a token from DEV_TOKENS.",
        },
      },
    },
    { status: 401, headers: { "www-authenticate": "Bearer" } },
  );
