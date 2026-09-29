import { exports } from "cloudflare:workers";

let nextId = 1;

/** One stateless JSON-RPC request to `/mcp`, the way an MCP client sends it. */
export async function rpc(method: string, params: unknown = {}, token = "dev-token-a") {
  const res = await exports.default.fetch("http://kalamo/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON-RPC results
  return { res, body: (await res.json()) as any };
}

/** `tools/call`, returning the CallToolResult. */
export async function call(name: string, args: unknown, token?: string) {
  const { body } = await rpc("tools/call", { name, arguments: args }, token);
  if (body.error) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** Parses the error JSON that a failed tool call returns as text. */
export const errorOf = (result: { isError?: boolean; content: { text: string }[] }) =>
  result.isError ? JSON.parse(result.content[0]?.text ?? "null") : null;
