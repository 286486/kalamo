import type { ServerMessage } from "@kalamo/sync";
import { authorizeMcp, hostedRpc } from "./authorize.ts";
import { errorOf } from "./rpc.ts";
import { APP_ORIGIN, hosted, signIn } from "./signin.ts";

// Signed-in people for GitHub-mode tests: their browser requests, sockets and MCP tool calls.

export interface Person {
  login: string;
  cookie: string;
  token: string;
}

let nextGithubId = 300;

/** A signed-in person with a read-and-edit (or read-only) MCP token. */
export async function person(login: string, readOnly = false): Promise<Person> {
  const { cookie } = await signIn({ id: nextGithubId++, login });
  const { tokens } = await authorizeMcp(cookie, { readOnly });
  return { login, cookie, token: tokens.access_token };
}

/** A tool call over hosted `/mcp`: its structuredContent, or its error. */
export async function tool(who: Person, name: string, args: object) {
  const { body } = await hostedRpc(who.token, "tools/call", { name, arguments: args });
  const result = body.result;
  return { ok: result.structuredContent, error: errorOf(result) };
}

export const bytes = (url: string) =>
  Uint8Array.from(atob(url.split(",")[1] ?? ""), (c) => c.charCodeAt(0));

/** A cookie-authenticated browser request from Kalamo's own page. */
export const browser = (who: Person, path: string, init: RequestInit = {}) =>
  hosted(path, {
    ...init,
    headers: { cookie: who.cookie, origin: APP_ORIGIN, ...init.headers },
  });

export const shareWith = (owner: Person, docId: string, login: string, role: string) =>
  browser(owner, `/api/docs/${docId}/members/${login}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });

/** Opens a browser socket; `next()` resolves with each message in turn, `closed` with the close. */
export async function socket(who: Person, docId: string, headers: Record<string, string> = {}) {
  const res = await browser(who, `/api/docs/${docId}/ws`, {
    headers: { upgrade: "websocket", ...headers },
  });
  const ws = res.webSocket;
  if (!ws) return { res, ws: null };
  const queue: ServerMessage[] = [];
  const waiting: ((m: ServerMessage) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data as string) as ServerMessage;
    const w = waiting.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  const closed = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));
  ws.accept();
  const next = () =>
    new Promise<ServerMessage>((r) => {
      const m = queue.shift();
      if (m) r(m);
      else waiting.push(r);
    });
  const send = (id: string, command: unknown) =>
    ws.send(JSON.stringify({ type: "command", id, command }));
  return { res, ws, next, send, closed };
}
