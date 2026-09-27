import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeMcp,
  authorizeQuery,
  hostedRpc,
  openConsent,
  pkce,
  REDIRECT_URI,
  register,
  submitConsent,
  token,
} from "./authorize.ts";
import { APP_ORIGIN, githubEnv, hosted, signIn } from "./signin.ts";

afterEach(() => vi.restoreAllMocks());

const userId = (githubId: number) =>
  env.DB.prepare("SELECT id FROM users WHERE github_id = ?").bind(githubId).first<string>("id");

const agentRows = async (githubId: number) =>
  (
    await env.DB.prepare(
      "SELECT * FROM actors WHERE kind = 'agent' AND user_id = ? ORDER BY created_at",
    )
      .bind(await userId(githubId))
      .all<{ id: string; name: string; access: string; revoked_at: string | null }>()
  ).results;

describe("discovery", () => {
  it("answers unauthenticated /mcp 401 with the resource metadata to follow", async () => {
    for (const bearer of [undefined, "not-a-token", "a:b:c"]) {
      const { res } = await hostedRpc(bearer, "ping");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(
        `resource_metadata="${APP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
      );
    }
  });

  it("serves the protected resource and authorization server metadata", async () => {
    const resource = await (await hosted("/.well-known/oauth-protected-resource/mcp")).json();
    expect(resource).toMatchObject({
      resource: `${APP_ORIGIN}/mcp`,
      authorization_servers: [APP_ORIGIN],
      scopes_supported: ["zibel:read", "zibel:write"],
    });
    const server = await (await hosted("/.well-known/oauth-authorization-server")).json();
    expect(server).toMatchObject({
      issuer: APP_ORIGIN,
      authorization_endpoint: `${APP_ORIGIN}/authorize`,
      token_endpoint: `${APP_ORIGIN}/oauth/token`,
      registration_endpoint: `${APP_ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["zibel:read", "zibel:write", "offline_access"],
    });
  });

  it("names MCP_ORIGIN as the resource and APP_ORIGIN as its authorization server", async () => {
    const e = { ...githubEnv, MCP_ORIGIN: "https://mcp.zibel.test" };
    const res = await hosted(
      "https://mcp.zibel.test/.well-known/oauth-protected-resource/mcp",
      {},
      e,
    );
    expect(await res.json()).toMatchObject({
      resource: "https://mcp.zibel.test/mcp",
      authorization_servers: [APP_ORIGIN],
    });
  });
});

describe("authorization", () => {
  it("yields a token that acts as a new Agent Actor of the User", async () => {
    const { cookie } = await signIn({ id: 201, login: "ada" });
    const { tokens } = await authorizeMcp(cookie);
    expect(tokens.scope.split(" ").sort()).toEqual(["offline_access", "zibel:read", "zibel:write"]);

    const { res } = await hostedRpc(tokens.access_token, "ping");
    expect(res.status).toBe(200);
    const created = await hostedRpc(tokens.access_token, "tools/call", {
      name: "zibel_doc_create",
      arguments: { name: "Doc", artboards: [{ width: 10, height: 10 }] },
    });
    const { docId, defaultLayerId } = created.body.result.structuredContent;
    await hostedRpc(tokens.access_token, "tools/call", {
      name: "zibel_node_create",
      arguments: {
        docId,
        nodes: [{ type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 1, height: 1 }],
      },
    });
    const changes = await hostedRpc(tokens.access_token, "tools/call", {
      name: "zibel_doc_changes",
      arguments: { docId, sinceRev: 0 },
    });

    const [agent] = await agentRows(201);
    expect(agent).toMatchObject({ name: "Claude Code (ada)", access: "write", revoked_at: null });
    expect(agent?.id).toMatch(/^agent_/);
    const actors = changes.body.result.structuredContent.changes.map(
      (c: { actor: string }) => c.actor,
    );
    expect(actors.length).toBeGreaterThan(0);
    expect(new Set(actors)).toEqual(new Set([agent?.id]));
  });

  it("sends a signed-out person through GitHub sign-in and back to /authorize", async () => {
    const clientId = await register();
    const query = authorizeQuery(clientId, (await pkce()).challenge);
    const res = await hosted(`/authorize?${query}`);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "", APP_ORIGIN);
    expect(to.pathname).toBe("/auth/github");
    expect(to.searchParams.get("return")).toBe(`/authorize?${query}`);
    const { res: back } = await signIn({ id: 202, login: "bea" }, `/authorize?${query}`);
    expect(back.headers.get("location")).toBe(`/authorize?${query}`);
  });

  it("shows a consent page naming the client and its redirect host, unframeable", async () => {
    const { cookie } = await signIn({ id: 203, login: "cy" });
    const clientId = await register('<img src=x onerror="alert(1)">');
    const { res, html } = await openConsent(
      cookie,
      authorizeQuery(clientId, (await pkce()).challenge),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain("&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("<strong>127.0.0.1</strong>");
    expect(html).toContain('name="readonly"');
  });

  it("records a read-only choice as read access and scope", async () => {
    const { cookie } = await signIn({ id: 204, login: "dee" });
    const { tokens } = await authorizeMcp(cookie, { name: "Cursor", readOnly: true });
    expect(tokens.scope.split(" ")).not.toContain("zibel:write");
    expect(await agentRows(204)).toMatchObject([{ name: "Cursor (dee)", access: "read" }]);
    expect((await hostedRpc(tokens.access_token, "ping")).res.status).toBe(200);
  });

  it("keeps the Actor when the same client re-authorizes", async () => {
    const { cookie } = await signIn({ id: 205, login: "eve" });
    const { clientId } = await authorizeMcp(cookie);
    await authorizeMcp(cookie, { clientId, readOnly: true });
    expect(await agentRows(205)).toMatchObject([{ name: "Claude Code (eve)", access: "read" }]);
    await authorizeMcp(cookie, { name: "Cursor" });
    expect((await agentRows(205)).map((a) => a.name)).toEqual([
      "Claude Code (eve)",
      "Cursor (eve)",
    ]);
  });

  it("answers Deny with an access_denied redirect to the client", async () => {
    const { cookie } = await signIn({ id: 206, login: "fay" });
    const clientId = await register();
    const consent = await openConsent(cookie, authorizeQuery(clientId, (await pkce()).challenge));
    const res = await submitConsent(consent.cookie, { handle: consent.handle, decision: "deny" });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe(REDIRECT_URI);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("client-state");
    expect(await agentRows(206)).toEqual([]);
  });

  it("redirects an invalid request to a known redirect URI, and never to an unknown one", async () => {
    const { cookie } = await signIn({ id: 207, login: "gus" });
    const clientId = await register();
    const bad = new URLSearchParams(authorizeQuery(clientId, (await pkce()).challenge));
    bad.set("code_challenge_method", "plain");
    const res = await hosted(`/authorize?${bad}`, { headers: { cookie } });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe(REDIRECT_URI);
    expect(to.searchParams.get("error")).toBe("invalid_request");

    const mismatched = new URLSearchParams(authorizeQuery(clientId, (await pkce()).challenge));
    mismatched.set("redirect_uri", "https://evil.example/callback");
    const refused = await hosted(`/authorize?${mismatched}`, { headers: { cookie } });
    expect(refused.status).toBe(400);
    expect(refused.headers.get("location")).toBeNull();
    const unknown = new URLSearchParams(authorizeQuery("no-such-client", "x"));
    expect((await hosted(`/authorize?${unknown}`, { headers: { cookie } })).status).toBe(400);
  });

  it("refuses a consent POST without the handle, or from another browser", async () => {
    const { cookie } = await signIn({ id: 208, login: "hal" });
    const clientId = await register();
    const consent = await openConsent(cookie, authorizeQuery(clientId, (await pkce()).challenge));
    const forged = [
      submitConsent(consent.cookie, { decision: "approve" }),
      submitConsent(cookie, { handle: consent.handle, decision: "approve" }),
    ];
    for (const res of await Promise.all(forged)) {
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    const crossSite = await hosted("/authorize", {
      method: "POST",
      headers: {
        cookie: consent.cookie,
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ handle: consent.handle, decision: "approve" }).toString(),
    });
    expect(crossSite.status).toBe(403);
    expect(await agentRows(208)).toEqual([]);
  });
});

describe("tokens", () => {
  it("rotates the refresh token: the new tokens work, the old refresh token is refused", async () => {
    const { cookie } = await signIn({ id: 209, login: "ida" });
    const { tokens, clientId } = await authorizeMcp(cookie);
    const refresh = (refresh_token: string) =>
      token({ grant_type: "refresh_token", refresh_token, client_id: clientId });
    const first = await refresh(tokens.refresh_token);
    expect(first.res.status).toBe(200);
    expect((await hostedRpc(first.body.access_token, "ping")).res.status).toBe(200);
    // Using the new refresh token retires the one before it.
    const second = await refresh(first.body.refresh_token ?? "");
    expect(second.res.status).toBe(200);
    const stale = await refresh(tokens.refresh_token);
    expect(stale.res.status).toBe(400);
    expect(stale.body.error).toBe("invalid_grant");
  });

  it("refuses a token issued for another resource", async () => {
    const { cookie } = await signIn({ id: 210, login: "jo" });
    const { tokens } = await authorizeMcp(cookie);
    const e = { ...githubEnv, MCP_ORIGIN: "https://mcp.zibel.test" };
    const { res } = await hostedRpc(
      tokens.access_token,
      "ping",
      {},
      {
        e,
        url: "https://mcp.zibel.test/mcp",
      },
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("Connected Agents", () => {
  it("lists the User's Agents and revokes one: its tokens stop, its row keeps the name", async () => {
    const { cookie } = await signIn({ id: 211, login: "kim" });
    const claude = await authorizeMcp(cookie);
    const cursor = await authorizeMcp(cookie, { name: "Cursor", readOnly: true });
    const other = await signIn({ id: 212, login: "lee" });
    await authorizeMcp(other.cookie);

    const list = await (await hosted("/api/agents", { headers: { cookie } })).json<{
      agents: { actorId: string; name: string; access: string; createdAt: string }[];
    }>();
    expect(list.agents.map((a) => [a.name, a.access]).sort()).toEqual([
      ["Claude Code (kim)", "write"],
      ["Cursor (kim)", "read"],
    ]);
    const target = list.agents.find((a) => a.name === "Claude Code (kim)")?.actorId ?? "";

    // Another User cannot revoke it.
    const foreign = await hosted(`/api/agents/${target}`, {
      method: "DELETE",
      headers: { cookie: other.cookie, origin: APP_ORIGIN },
    });
    expect(foreign.status).toBe(404);

    const res = await hosted(`/api/agents/${target}`, {
      method: "DELETE",
      headers: { cookie, origin: APP_ORIGIN },
    });
    expect(res.status).toBe(204);
    expect((await hostedRpc(claude.tokens.access_token, "ping")).res.status).toBe(401);
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: claude.tokens.refresh_token,
      client_id: claude.clientId,
    });
    expect(refreshed.res.status).toBe(400);
    expect((await hostedRpc(cursor.tokens.access_token, "ping")).res.status).toBe(200);

    const rows = await agentRows(211);
    expect(rows.find((r) => r.id === target)).toMatchObject({
      name: "Claude Code (kim)",
      revoked_at: expect.any(String),
    });
    const after = await (await hosted("/api/agents", { headers: { cookie } })).json<{
      agents: { name: string }[];
    }>();
    expect(after.agents.map((a) => a.name)).toEqual(["Cursor (kim)"]);

    // Authorizing again makes a new Actor; the revoked one stays revoked.
    await authorizeMcp(cookie, { clientId: claude.clientId });
    expect((await agentRows(211)).filter((r) => r.name === "Claude Code (kim)")).toHaveLength(2);
  });

  it("refuses the Agent routes without a session", async () => {
    expect((await hosted("/api/agents")).status).toBe(401);
    const res = await hosted("/api/agents/agent_x", {
      method: "DELETE",
      headers: { origin: APP_ORIGIN },
    });
    expect(res.status).toBe(401);
  });
});
