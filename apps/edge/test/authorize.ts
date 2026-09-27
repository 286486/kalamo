import { mcpOrigin } from "../src/oauth.ts";
import { APP_ORIGIN, githubEnv, hosted } from "./signin.ts";

export const REDIRECT_URI = "http://127.0.0.1:33418/callback";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A PKCE S256 verifier and its challenge. */
export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

/** Dynamic client registration of a public client, as Claude Code does it. */
export async function register(name = "Claude Code", redirectUri = REDIRECT_URI, e = githubEnv) {
  const res = await hosted(
    "/oauth/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    },
    e,
  );
  if (!res.ok) throw new Error(`registration failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** The `/authorize` query a client sends. */
export const authorizeQuery = (
  clientId: string,
  challenge: string,
  redirectUri = REDIRECT_URI,
  e = githubEnv,
) =>
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "client-state",
    scope: "zibel:read zibel:write offline_access",
    resource: `${mcpOrigin(e)}/mcp`,
  }).toString();

/** The consent page for a signed-in `cookie`: its handle and the cookie binding it to the browser. */
export async function openConsent(cookie: string, query: string, e = githubEnv) {
  const res = await hosted(`/authorize?${query}`, { headers: { cookie } }, e);
  const html = await res.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
  const binding = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { res, html, handle, cookie: `${cookie}; ${binding}` };
}

/** The consent form's POST. */
export const submitConsent = (cookie: string, fields: Record<string, string>, e = githubEnv) =>
  hosted(
    "/authorize",
    {
      method: "POST",
      headers: {
        cookie,
        origin: APP_ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
    },
    e,
  );

/** A token endpoint request. */
export async function token(fields: Record<string, string>, e = githubEnv) {
  const res = await hosted(
    "/oauth/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    },
    e,
  );
  return { res, body: (await res.json()) as Record<string, string> };
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  scope: string;
}

/**
 * A whole MCP authorization for a signed-in `cookie`: DCR, `/authorize`, consent, the code and
 * the PKCE token exchange. Returns the tokens and the client id.
 */
export async function authorizeMcp(
  cookie: string,
  { name = "Claude Code", readOnly = false, clientId = "", e = githubEnv } = {},
) {
  const client = clientId || (await register(name, REDIRECT_URI, e));
  const { verifier, challenge } = await pkce();
  const consent = await openConsent(cookie, authorizeQuery(client, challenge, REDIRECT_URI, e), e);
  if (!consent.handle) throw new Error(`no consent page: ${consent.res.status} ${consent.html}`);
  const approved = await submitConsent(
    consent.cookie,
    { handle: consent.handle, decision: "approve", ...(readOnly && { readonly: "on" }) },
    e,
  );
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code");
  if (!code) throw new Error(`no code: ${approved.status} ${approved.headers.get("location")}`);
  const { res, body } = await token(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client,
      code_verifier: verifier,
      resource: `${mcpOrigin(e)}/mcp`,
    },
    e,
  );
  if (!res.ok) throw new Error(`token exchange failed: ${JSON.stringify(body)}`);
  return { tokens: body as unknown as Tokens, clientId: client };
}

/** One JSON-RPC request to hosted `/mcp` with a Bearer token. */
export async function hostedRpc(
  token: string | undefined,
  method: string,
  params: unknown = {},
  { e = githubEnv, url = "/mcp" } = {},
) {
  const res = await hosted(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    e,
  );
  const body = res.headers.get("content-type")?.includes("json")
    ? // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON-RPC results
      ((await res.json()) as any)
    : null;
  return { res, body };
}
