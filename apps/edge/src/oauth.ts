import {
  AuthorizationError,
  type AuthRequest,
  CimdFetchError,
  type ClientInfo,
  OAuthProvider,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { newId } from "@zibel/core";
import { type Principal, sessionUser, signInRequired, type User } from "./auth.ts";

/**
 * MCP OAuth 2.1 (ADR-0047): Zibel is its own authorization server in front of GitHub sign-in. The
 * library serves discovery, registration, the token endpoint and revocation; Zibel owns
 * `/authorize`, the consent page, and the Agent Actor each approved client becomes.
 */

const READ = "zibel:read";
const WRITE = "zibel:write";
const OFFLINE = "offline_access";

type Handler = Required<Pick<ExportedHandler<Env>, "fetch">>;

/** The origin of `/mcp`, the OAuth resource: MCP_ORIGIN, or APP_ORIGIN when they are one. */
export const mcpOrigin = (env: Env) => env.MCP_ORIGIN || env.APP_ORIGIN;

// One entry per deploy; tests build a second to check audience binding across origins.
const providers = new Map<string, OAuthProvider<Env>>();

/** The provider for this deploy's two origins, built once per isolate. */
export function oauthProvider(env: Env, app: Handler, api: Handler): OAuthProvider<Env> {
  const key = `${env.APP_ORIGIN} ${mcpOrigin(env)}`;
  let provider = providers.get(key);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: api,
      defaultHandler: app,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [READ, WRITE, OFFLINE],
      accessTokenTTL: 3600,
      refreshTokenTTL: 30 * 86_400,
      resourceMetadata: {
        resource: `${mcpOrigin(env)}/mcp`,
        authorization_servers: [env.APP_ORIGIN],
        scopes_supported: [READ, WRITE],
        resource_name: "Zibel",
      },
    });
    providers.set(key, provider);
  }
  return provider;
}

/**
 * The Principal of an OAuth-authenticated `/mcp` request, or null once its Agent is revoked. The
 * D1 check makes revocation immediate where KV, which holds the grant, may lag.
 */
export async function agentPrincipal(env: Env, ctx: ExecutionContext): Promise<Principal | null> {
  const { props, auth } = ctx as OAuthResourceContext<Principal>;
  const live = await env.DB.prepare("SELECT 1 FROM actors WHERE id = ? AND revoked_at IS NULL")
    .bind(props.actor)
    .first();
  if (!live) return null;
  // A refresh may narrow the scopes, never widen them; the token's own scopes cap the grant's.
  const access = props.access === "write" && auth.scope.includes(WRITE) ? "write" : "read";
  return { userId: props.userId, actor: props.actor, access };
}

/** The 401 challenge for a revoked Agent's token, pointing at the metadata to authorize again. */
export const revokedChallenge = (env: Env) =>
  `Bearer error="invalid_token", resource_metadata="${mcpOrigin(env)}/.well-known/oauth-protected-resource/mcp"`;

/** `/authorize` and `/api/agents`, or null for any other path. GitHub mode only. */
export function oauthRoute(request: Request, env: Env): Promise<Response> | null {
  const { pathname } = new URL(request.url);
  const route = `${request.method} ${pathname}`;
  if (route === "GET /authorize") return guard(() => consent(request, env));
  if (route === "POST /authorize") return guard(() => decide(request, env));
  if (route === "GET /api/agents") return agents(request, env);
  const actorId = pathname.match(/^\/api\/agents\/([^/]+)$/)?.[1];
  if (actorId && request.method === "DELETE") return revokeAgent(request, env, actorId);
  return null;
}

/**
 * Parses the client's request, sends a signed-out person through GitHub sign-in and back, and
 * shows the consent page, whose form the library binds to this browser (the CSRF token).
 */
async function consent(request: Request, env: Env) {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const user = await sessionUser(request, env);
  if (!user) {
    const url = new URL(request.url);
    const back = encodeURIComponent(url.pathname + url.search);
    return new Response(null, {
      status: 302,
      headers: { location: `/auth/github?return=${back}` },
    });
  }
  const client = await oauth.lookupClient(authRequest.clientId);
  if (!client) return errorPage("This app is not registered with Zibel. Connect it again.");
  const { handle, headers } = await oauth.beginConsent(authRequest);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(consentPage(client, authRequest, handle, user), { headers });
}

/** The consent form's Approve or Deny. Approve makes or keeps the client's Agent Actor. */
async function decide(request: Request, env: Env) {
  const oauth = env.OAUTH_PROVIDER;
  const user = await sessionUser(request, env);
  if (!user) return signInRequired();
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const readOnly = form.has("readonly");
  // The consent page picks the scopes: read, and write unless read-only. Every grant gets a
  // refresh token, so `offline_access` is granted whether or not it was asked for.
  const approved = await oauth.approveConsent(request, handle, {
    scope: [READ, ...(readOnly ? [] : [WRITE]), OFFLINE],
  });
  const authRequest = approved.request;
  const access = readOnly ? "read" : "write";
  const actor = await agentActorId(env, user, authRequest);
  const { redirectTo } = await oauth.completeAuthorization({
    request: authRequest,
    userId: user.id,
    metadata: { actor },
    scope: authRequest.scope,
    props: { userId: user.id, actor, access } satisfies Principal,
  });
  // Written once the grant exists, so a failed authorization leaves no Agent listed.
  const client = await oauth.lookupClient(authRequest.clientId);
  const now = new Date().toISOString();
  const upsert = env.DB.prepare(
    `INSERT INTO actors (id, user_id, kind, client_id, redirect_uri, name, access, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, access = excluded.access`,
  ).bind(
    actor,
    user.id,
    authRequest.clientId,
    authRequest.redirectUri,
    `${client?.clientName || authRequest.clientId} (${user.login})`,
    access,
    now,
  );
  // The library replaced every earlier grant of a DCR client for this User, whatever its
  // redirect URI (a CIMD client's only on the same one, whose Actor is reused), so the Actors
  // of those grants are retired. Pinned to workers-oauth-provider 1.1.0's `completeAuthorization`.
  const retire = env.DB.prepare(
    `UPDATE actors SET revoked_at = ? WHERE user_id = ? AND kind = 'agent' AND client_id = ?
     AND id != ? AND revoked_at IS NULL`,
  ).bind(now, user.id, authRequest.clientId, actor);
  await env.DB.batch(authRequest.clientId.startsWith("https://") ? [upsert] : [retire, upsert]);
  approved.headers.set("location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

/**
 * The Agent Actor id for this User, client id and redirect URI: the unrevoked one they already
 * have, so re-authorizing keeps it, or a new `agent_<id>`.
 */
async function agentActorId(env: Env, user: User, authRequest: AuthRequest) {
  const existing = await env.DB.prepare(
    `SELECT id FROM actors WHERE user_id = ? AND kind = 'agent' AND client_id = ?
     AND redirect_uri = ? AND revoked_at IS NULL`,
  )
    .bind(user.id, authRequest.clientId, authRequest.redirectUri)
    .first<string>("id");
  return existing ?? `agent_${newId()}`;
}

/** `GET /api/agents`: the signed-in User's connected Agents, newest first. */
async function agents(request: Request, env: Env) {
  const user = await sessionUser(request, env);
  if (!user) return signInRequired();
  const { results } = await env.DB.prepare(
    `SELECT id AS actorId, name, access, created_at AS createdAt FROM actors
     WHERE user_id = ? AND kind = 'agent' AND revoked_at IS NULL ORDER BY created_at DESC`,
  )
    .bind(user.id)
    .all();
  return Response.json({ agents: results });
}

/**
 * `DELETE /api/agents/:actorId`: revokes the Agent's grants, so its tokens stop working, and marks
 * the row revoked. The row stays, so history keeps the Agent's name.
 */
async function revokeAgent(request: Request, env: Env, actorId: string) {
  const user = await sessionUser(request, env);
  if (!user) return signInRequired();
  const { meta } = await env.DB.prepare(
    `UPDATE actors SET revoked_at = ? WHERE id = ? AND user_id = ? AND kind = 'agent'
     AND revoked_at IS NULL`,
  )
    .bind(new Date().toISOString(), actorId, user.id)
    .run();
  if (!meta.changes) return new Response("not found", { status: 404 });
  const oauth = env.OAUTH_PROVIDER;
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(user.id, { cursor });
    for (const grant of page.items) {
      if (grant.metadata?.actor === actorId) await oauth.revokeGrant(grant.id, user.id);
    }
    cursor = page.cursor;
  } while (cursor);
  return new Response(null, { status: 204 });
}

/**
 * Runs an `/authorize` step, turning the library's validation errors into what OAuth allows: an
 * error redirect once the client and its exact redirect URI are known, a local page otherwise.
 */
async function guard(step: () => Promise<Response>) {
  try {
    return await step();
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectUri) {
      const redirect = new URL(error.redirectUri);
      redirect.searchParams.set("error", error.code);
      redirect.searchParams.set("error_description", error.description);
      if (error.state) redirect.searchParams.set("state", error.state);
      if (error.issuer) redirect.searchParams.set("iss", error.issuer);
      return Response.redirect(redirect.href, 302);
    }
    if (error instanceof AuthorizationError) return errorPage(error.description);
    if (error instanceof CimdFetchError) return errorPage("This app could not be verified.");
    throw error;
  }
}

const errorPage = (message: string) =>
  new Response(message, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The consent page: the client's name and where its access goes, who is signed in, and a read-only
 * choice. Everything from the client is escaped: registration lets anyone choose it.
 */
function consentPage(client: ClientInfo, authRequest: AuthRequest, handle: string, user: User) {
  const name = escapeHtml(client.clientName || client.clientId);
  const host = new URL(authRequest.redirectUri).hostname;
  // A client that asked for scopes but not write starts read-only; the person may still widen it.
  const readOnly = authRequest.scope.length > 0 && !authRequest.scope.includes(WRITE);
  const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(host);
  const origin = client.clientId.startsWith("https://")
    ? `Published by <strong>${escapeHtml(new URL(client.clientId).hostname)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${name} to Zibel</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 30rem; margin: 3rem auto; padding: 0 16px; }
  .warn { background: #fff4d6; padding: 8px 12px; border-radius: 4px; }
  button { font: inherit; padding: 6px 16px; margin-right: 8px; }
</style>
<h1>Connect ${name} to Zibel?</h1>
<p>${origin} Its access goes to <strong>${escapeHtml(host)}</strong>.</p>
${loopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}
<p>It becomes an Agent of <strong>${escapeHtml(user.login)}</strong>, named after the app, that can read your Documents and, unless you choose read only, edit them. You can revoke it at any time.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <p><label><input type="checkbox" name="readonly"${readOnly ? " checked" : ""}> Read only: it can view but not edit</label></p>
  <p><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></p>
</form>
</html>`;
}
