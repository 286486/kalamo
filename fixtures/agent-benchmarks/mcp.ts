/** A `tools/call` result, the fields the assertions read. */
export interface ToolResult {
  isError?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: assertions read arbitrary structured results
  structuredContent?: any;
  content: { type: string; text?: string }[];
}

/** Calls one zibel tool; the runner's is `httpCall`, the unit test's goes through the Worker. */
export type Call = (name: string, args: unknown) => Promise<ToolResult>;

/** A task's assertions: throw an Error naming what is wrong. `tools` are the Agent's calls, in order. */
export type Check = (call: Call, docId: string, tools: string[]) => Promise<void>;

/** Builds what a task's prompt says already exists, in a Document named `name`; returns its docId. */
export type Setup = (call: Call, name: string) => Promise<string>;

let nextId = 1;

/** Stateless JSON-RPC over Streamable HTTP with JSON responses (ADR-0006). */
export const httpCall =
  (url: string, token: string): Call =>
  async (name, args) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as { result?: ToolResult; error?: unknown };
    if (!body.result) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
    if (body.result.isError) throw new Error(`${name}: ${body.result.content[0]?.text}`);
    return body.result;
  };

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

/** A number as the assertions compare it: the 3 decimals the Document stores. */
export const n3 = (x: number) => Math.round(x * 1000) / 1000;
