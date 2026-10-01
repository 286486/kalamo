/** A `tools/call` result, the fields the assertions read. */
export interface ToolResult {
  isError?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: assertions read arbitrary structured results
  structuredContent?: any;
  content: { type: string; text?: string }[];
}

/** Calls one Kalamo tool; the runner's is `httpCall`, the unit test's goes through the Worker. */
export type Call = (name: string, args: unknown) => Promise<ToolResult>;

/** A task's assertions: throw an Error naming what is wrong. `tools` are the Agent's calls, in order. */
export type Check = (call: Call, docId: string, tools: string[]) => Promise<void>;

/** A write-SVG session's text files, by name: what it starts with, or what it leaves. */
export type Files = Record<string, string>;

/** What a setup made: the Document the MCP arm edits, and the files the SVG arm starts with. */
export interface Start {
  docId: string;
  files?: Files;
}

/** Builds what a task's prompts say already exists, in a Document named `name`; `other` is a
 * second Actor, the one whose changes an Agent must find. */
export type Setup = (call: Call, name: string, other: Call) => Promise<Start>;

/** A task's assertions on the files a write-SVG session left; `call` opens them in Kalamo. */
export type SvgCheck = (call: Call, files: Files) => Promise<void>;

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

/** Opens a written SVG file as a new Document, the way the SVG arm is judged; returns its docId. */
export async function openSvg(call: Call, svg: string | undefined): Promise<string> {
  assert(svg, "the session left no such SVG file");
  return (await call("kalamo_doc_open", { content: svg })).structuredContent.docId;
}

/** The Document as the SVG file a write-SVG session starts from. */
export const exportSvg = async (call: Call, docId: string) =>
  (await call("kalamo_export", { docId, format: "svg" })).content[0]?.text ?? "";

/** A shape or text as `kalamo_node_get` gives it in full, the fields the assertions read. */
export interface Leaf {
  id: string;
  type: string;
  name: string;
  parentId: string | null;
  geometricBounds: Bounds;
  appearance: { fills: { color: string }[]; strokes: { color: string; width: number }[] };
  kind?: "point" | "area";
  content?: string;
}

/** Every Node but Layers and Groups, in full and in stacking order, bottom first. */
export async function leaves(call: Call, docId: string): Promise<Leaf[]> {
  type Entry = { id: string; type: string; children?: Entry[] };
  const { nodes } = (await call("kalamo_doc_outline", { docId, depth: 100, includeBounds: false }))
    .structuredContent as { nodes: Entry[] };
  const flat = (es: Entry[]): Entry[] => es.flatMap((e) => [e, ...flat(e.children ?? [])]);
  const ids = flat(nodes)
    .filter((e) => e.type !== "layer" && e.type !== "group")
    .map((e) => e.id);
  if (ids.length === 0) return [];
  return (await call("kalamo_node_get", { docId, nodeIds: ids, detail: "full" })).structuredContent
    .nodes;
}

/** A colour as the assertions compare it. */
export const hex = (c: string | undefined) => c?.toUpperCase();
