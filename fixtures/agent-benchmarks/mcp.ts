/** A `tools/call` result, the fields the assertions read. */
export interface ToolResult {
  isError?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: assertions read arbitrary structured results
  structuredContent?: any;
  content: { type: string; text?: string }[];
}

/** Calls one Kalamo tool; the runner's is `httpCall`, the unit test's goes through the Worker. */
export type Call = (name: string, args: unknown) => Promise<ToolResult>;

/** A task's session: the Agent Actor it runs as, and the MCP client it runs in. */
export interface Agent {
  actor: string;
  client: "claude" | "codex";
}

/** One `tools/call` an Agent made, as the bench's proxy saw it go to `/mcp`. */
export interface Logged {
  actor: string;
  /** The `clientInfo.name` its MCP client sent in `initialize`. */
  client: string;
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: assertions read arbitrary arguments
  args: any;
  /** Absent when the answer was not a JSON-RPC result. */
  result?: ToolResult;
}

/** A Transaction someone other than an Agent committed: the setup, or a scripted browser User. */
export interface Commit {
  actor: string;
  rev: number;
}

/** What happened besides the Document: every Agent call, and every other commit. */
export interface Trace {
  calls: Logged[];
  commits: Commit[];
}

/**
 * A task's assertions: throw an Error naming what is wrong. `tools` are the Agents' calls by name,
 * in order.
 */
export type Check = (call: Call, docId: string, tools: string[], trace?: Trace) => Promise<void>;

/** A write-SVG session's text files, by name: what it starts with, or what it leaves. */
export type Files = Record<string, string>;

/**
 * Runs before the bench forwards each Agent call to `/mcp`, so people can edit the Document while
 * that Agent works.
 */
// biome-ignore lint/suspicious/noExplicitAny: a task reads the arguments it cares about
export type Interject = (actor: string, name: string, args: any) => Promise<void>;

/** What a setup made: the Document the MCP arm edits, and the files the SVG arm starts with. */
export interface Start {
  docId: string;
  files?: Files;
  interject?: Interject;
  /** The setup's and its people's commits, filled in as they make them. */
  commits?: Commit[];
  /** Closes what the setup opened, once the check is done. */
  close?: () => void;
}

/** Opens the Document's WebSocket as the dev-mode browser User `user` (ADR-0090). */
export type Connect = (user: string, docId: string) => Promise<WebSocket>;

/** Builds what a task's prompts say already exists, in a Document named `name`; `other` is a
 * second Actor, the one whose changes an Agent must find. */
export type Setup = (call: Call, name: string, other: Call, connect?: Connect) => Promise<Start>;

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

/** A scripted browser User on one Document: its gestures as commands, ADR-0010's wire protocol. */
export async function browserUser(connect: Connect, user: string, docId: string) {
  const ws = await connect(user, docId);
  const actor = `user_${user}`;
  const ids = new Map<string, string>(); // the Nodes it has seen, by name
  const acks = new Map<string, { resolve(rev: number): void; reject(e: Error): void }>();
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("close", () => reject(new Error(`${user}'s socket closed`)));
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string);
      if (m.type === "document" || m.type === "tx")
        for (const n of m.type === "document" ? m.nodes : [...m.created, ...m.updated])
          ids.set(n.name, n.id);
      if (m.type === "document") resolve();
      if (m.type === "tx") acks.get(m.commandId)?.resolve(m.rev);
      if (m.type === "rejected")
        acks.get(m.id)?.reject(new Error(`${user}'s command: ${JSON.stringify(m.error)}`));
    });
  });
  (ws as { accept?(): void }).accept?.(); // a Workers socket delivers nothing until accepted
  await opened;
  let next = 1;
  return {
    id(name: string) {
      const id = ids.get(name);
      assert(id, `${user} sees no Node named ${name}`);
      return id;
    },
    /** Sends one command and resolves once its Transaction is committed. */
    async send(command: unknown): Promise<Commit> {
      const id = `${user}-${next++}`;
      const rev = await new Promise<number>((resolve, reject) => {
        acks.set(id, { resolve, reject });
        ws.send(JSON.stringify({ type: "command", id, command }));
      });
      return { actor, rev };
    },
    close: () => ws.close(),
  };
}
