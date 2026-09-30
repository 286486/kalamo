import type { APIRequestContext } from "@playwright/test";

/** One stateless MCP `tools/call` as Agent `agent-a`; returns the CallToolResult. */
export async function call(request: APIRequestContext, name: string, args: object) {
  const res = await request.post("/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer dev-token-a",
    },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  return (await res.json()).result;
}

/**
 * Lists Node ids with `list`, then reads them in full with `kalamo_node_get`. A write landing
 * between the two reads, such as a cut's delete, makes node_get refuse ids just listed with
 * NODE_NOT_FOUND. Both reads then start over, up to three times, since expect.poll fails at once
 * on a throw.
 */
export async function listThenGet<N>(
  request: APIRequestContext,
  docId: string,
  list: () => Promise<{ id: string }[]>,
): Promise<N[]> {
  for (let attempt = 0; ; attempt++) {
    const listed = await list();
    if (listed.length === 0) return [];
    const got = await call(request, "kalamo_node_get", {
      docId,
      nodeIds: listed.map((n) => n.id),
      detail: "full",
    });
    if (!got.isError) return got.structuredContent.nodes;
    const text = String(got.content?.[0]?.text);
    if (attempt === 2 || !text.includes('"NODE_NOT_FOUND"')) {
      throw new Error(`node_get failed: ${text}`);
    }
  }
}
