import { env, exports } from "cloudflare:workers";
import type { ServerMessage } from "@zibel/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call } from "./rpc.ts";
import { APP_ORIGIN, GITHUB_TOKEN, githubEnv, hosted, signIn } from "./signin.ts";

afterEach(() => vi.restoreAllMocks());

const me = (cookie: string) => hosted("/api/me", { headers: { cookie } });

const mcpPing = (e: Env, token?: string) =>
  hosted(
    "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    },
    e,
  );

describe("server misconfigured", () => {
  it.each(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "APP_ORIGIN", "DB"] as const)(
    "answers every request 500 without %s",
    async (key) => {
      const e = { ...githubEnv, [key]: undefined } as unknown as Env;
      for (const res of [await hosted("/api/docs", {}, e), await mcpPing(e, "dev-token-a")]) {
        expect(res.status).toBe(500);
        expect(await res.text()).toBe("server misconfigured");
      }
    },
  );

  it("is GitHub mode for any AUTH_MODE but dev", async () => {
    const e = { ...githubEnv, AUTH_MODE: "Dev" };
    expect((await hosted("/api/docs", {}, e)).status).toBe(401);
  });
});

describe("sign-in", () => {
  it("starts at GitHub with a state cookie and no scopes", async () => {
    const res = await hosted("/auth/github?return=/docs/abc");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("test-client");
    expect(to.searchParams.get("redirect_uri")).toBe(`${APP_ORIGIN}/auth/github/callback`);
    expect(to.searchParams.has("scope")).toBe(false);
    expect(res.headers.get("set-cookie")).toMatch(
      new RegExp(`^__Host-zibel_oauth=${to.searchParams.get("state")}\\|.*HttpOnly; Secure`),
    );
  });

  it("sets the session cookie, stores the User and its Actor, and returns to the page", async () => {
    const { res, cookie } = await signIn({ id: 101, login: "ada" }, "/docs/abc");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/docs/abc");
    expect(res.headers.getSetCookie()).toContainEqual(
      expect.stringMatching(
        /^__Host-zibel_session=[0-9a-f]{64}; Max-Age=\d+; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
      ),
    );
    const user = await env.DB.prepare("SELECT * FROM users WHERE github_id = 101").first<{
      id: string;
      login: string;
      avatar_url: string;
    }>();
    expect(user).toMatchObject({ login: "ada", avatar_url: "https://avatars.example/101" });
    const actor = await env.DB.prepare("SELECT * FROM actors WHERE user_id = ?")
      .bind(user?.id)
      .first();
    expect(actor).toMatchObject({ id: `user_${user?.id}`, kind: "user", name: "ada" });
    const body = await (await me(cookie)).json();
    expect(body).toEqual({
      userId: user?.id,
      login: "ada",
      avatarUrl: "https://avatars.example/101",
      mode: "github",
    });
  });

  it("refreshes the login of a returning User under the same id", async () => {
    await signIn({ id: 102, login: "old-name" });
    const { cookie } = await signIn({ id: 102, login: "new-name" });
    const { results } = await env.DB.prepare("SELECT login FROM users WHERE github_id = 102").all();
    expect(results).toEqual([{ login: "new-name" }]);
    const actors = await env.DB.prepare(
      "SELECT name FROM actors WHERE user_id = (SELECT id FROM users WHERE github_id = 102)",
    ).all();
    expect(actors.results).toEqual([{ name: "new-name" }]);
    expect(await (await me(cookie)).json()).toMatchObject({ login: "new-name" });
  });

  it("returns to the list for a path off the site", async () => {
    for (const bad of ["//evil.example/x", "https://evil.example", "/\\evil.example"]) {
      const { res } = await signIn({ id: 103, login: "bea" }, bad);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  it("refuses a callback with a missing or wrong state, starting no session", async () => {
    const start = await hosted("/auth/github");
    const stateCookie = start.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const [query, cookie] of [
      ["code=c&state=forged", stateCookie],
      ["code=c", stateCookie],
      [
        `code=c&state=${new URL(start.headers.get("location") ?? "").searchParams.get("state")}`,
        "",
      ],
    ] as const) {
      const res = await hosted(`/auth/github/callback?${query}`, { headers: { cookie } });
      expect(res.status).toBe(400);
      expect(res.headers.getSetCookie().join()).not.toContain("__Host-zibel_session=");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps no GitHub access token anywhere", async () => {
    const { cookie } = await signIn({ id: 104, login: "cy" });
    for (const table of ["users", "sessions", "actors", "documents"]) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(results)).not.toContain(GITHUB_TOKEN);
      // Only the token's hash is stored.
      expect(JSON.stringify(results)).not.toContain(cookie.split("=")[1]);
    }
  });
});

describe("sessions", () => {
  it("answers 401 to browser routes without a session", async () => {
    for (const cookie of ["", "__Host-zibel_session=nope"]) {
      for (const path of ["/api/me", "/api/docs"]) {
        const res = await hosted(path, { headers: { cookie } });
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ code: "PERMISSION_DENIED" });
      }
    }
  });

  it("ends at sign-out: the same cookie answers 401 at once", async () => {
    const { cookie } = await signIn({ id: 105, login: "dee" });
    expect((await me(cookie)).status).toBe(200);
    const out = await hosted("/auth/signout", {
      method: "POST",
      headers: { cookie, origin: APP_ORIGIN },
    });
    expect(out.status).toBe(303);
    expect(out.headers.get("set-cookie")).toMatch(/^__Host-zibel_session=; Max-Age=0/);
    expect((await me(cookie)).status).toBe(401);
  });

  it("expires after 30 days unused, and slides at most once a day", async () => {
    const { cookie } = await signIn({ id: 106, login: "eve" });
    const setLastSeen = (daysAgo: number) =>
      env.DB.prepare(
        "UPDATE sessions SET last_seen_at = ? WHERE user_id = (SELECT id FROM users WHERE github_id = 106)",
      )
        .bind(new Date(Date.now() - daysAgo * 86_400_000).toISOString())
        .run();
    const lastSeen = async () =>
      Date.parse(
        (await env.DB.prepare(
          "SELECT last_seen_at FROM sessions WHERE user_id = (SELECT id FROM users WHERE github_id = 106)",
        ).first<string>("last_seen_at")) ?? "",
      );

    await setLastSeen(0.5);
    const halfDay = await lastSeen();
    expect((await me(cookie)).status).toBe(200);
    expect(await lastSeen()).toBe(halfDay);

    await setLastSeen(29);
    expect((await me(cookie)).status).toBe(200);
    expect(Date.now() - (await lastSeen())).toBeLessThan(60_000);

    await setLastSeen(31);
    expect((await me(cookie)).status).toBe(401);
  });
});

describe("the Origin check", () => {
  it("refuses a cross-origin or origin-less POST and WebSocket upgrade with 403", async () => {
    const { cookie } = await signIn({ id: 107, login: "fay" });
    const { docId } = (
      await call("zibel_doc_create", { name: "Doc", artboards: [{ width: 10, height: 10 }] })
    ).structuredContent;
    for (const origin of ["https://evil.example", undefined]) {
      const headers = { cookie, ...(origin && { origin }) };
      const requests = [
        hosted("/api/docs?name=a.svg", { method: "POST", headers, body: "<svg/>" }),
        hosted(`/api/docs/${docId}/ws`, { headers: { ...headers, upgrade: "websocket" } }),
        hosted("/auth/signout", { method: "POST", headers }),
      ];
      for (const res of await Promise.all(requests)) {
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: "PERMISSION_DENIED" });
      }
    }
    // The refused sign-out left the session alone.
    expect((await me(cookie)).status).toBe(200);
  });

  it("lets Zibel's own pages POST", async () => {
    const { cookie } = await signIn({ id: 108, login: "gus" });
    const res = await hosted("/api/docs?name=a.svg", {
      method: "POST",
      headers: { cookie, origin: APP_ORIGIN },
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    });
    expect(res.status).toBe(200);
  });
});

describe("attribution", () => {
  it("records a signed-in browser's edit as its User Actor, whatever Actor header it sends", async () => {
    const { cookie } = await signIn({ id: 109, login: "hal" });
    const userId = await env.DB.prepare("SELECT id FROM users WHERE github_id = 109").first<string>(
      "id",
    );
    const { docId, defaultLayerId } = (
      await call("zibel_doc_create", { name: "Doc", artboards: [{ width: 100, height: 100 }] })
    ).structuredContent;
    const { createdIds, rev } = (
      await call("zibel_node_create", {
        docId,
        nodes: [{ type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 10, height: 10 }],
      })
    ).structuredContent;
    const res = await hosted(`/api/docs/${docId}/ws`, {
      headers: { cookie, origin: APP_ORIGIN, upgrade: "websocket", "x-zibel-actor": "forged" },
    });
    const ws = res.webSocket;
    if (!ws) throw new Error(`no WebSocket: ${res.status}`);
    const messages: ServerMessage[] = [];
    const tx = new Promise<ServerMessage>((resolve) =>
      ws.addEventListener("message", (e) => {
        messages.push(JSON.parse(e.data as string));
        if (messages.length === 2) resolve(messages[1] as ServerMessage);
      }),
    );
    ws.accept();
    const send = (id: string, command: unknown) =>
      ws.send(JSON.stringify({ type: "command", id, command }));
    send("h1", { type: "update", nodeId: createdIds[0], patch: { visible: false } });
    expect(await tx).toMatchObject({ type: "tx", actor: `user_${userId}`, commandId: "h1" });
    ws.close();

    const { changes } = (await call("zibel_doc_changes", { docId, sinceRev: rev }))
      .structuredContent;
    expect(changes).toMatchObject([{ actor: `user_${userId}`, summary: "Update 1 Node" }]);
  });
});

describe("MCP in GitHub mode", () => {
  it("still takes a dev token, and refuses without one", async () => {
    expect((await mcpPing(githubEnv, "dev-token-a")).status).toBe(200);
    expect((await mcpPing(githubEnv)).status).toBe(401);
    const noTokens = { ...githubEnv, DEV_TOKENS: undefined };
    expect((await mcpPing(noTokens, "dev-token-a")).status).toBe(401);
  });
});

describe("dev mode", () => {
  it("is the local User, with no sign-in routes", async () => {
    const res = await exports.default.fetch("http://zibel/api/me");
    expect(await res.json()).toEqual({
      userId: "local",
      login: "local",
      avatarUrl: null,
      mode: "dev",
    });
    expect((await exports.default.fetch("http://zibel/auth/github")).status).toBe(404);
  });
});
