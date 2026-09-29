import {
  type Artboard,
  type Document,
  type ErrorData,
  MaskInput,
  type Node,
  NodeInput,
  PathEditInput,
  PathOpInput,
  ReorderOp,
  ReparentInput,
  TransformInput,
  Writable,
} from "@kalamo/core";
import { z } from "zod";
import type { Role } from "./index.ts";

/**
 * Browser wire protocol: the Document on connect, then one `tx` per commit (ADR-0009). A browser
 * sends each gesture as a command and gets its `tx` or a `rejected` back (ADR-0010).
 */

/** Sent once, right after the WebSocket is accepted. */
export interface DocumentMessage {
  type: "document";
  rev: number;
  name: string;
  artboards: Artboard[];
  nodes: Node[];
  /** The socket's Role: a viewer's commands are rejected (ADR-0047). */
  role: Role;
}

/** One committed Transaction, with full copies of the Nodes it created or updated. */
export interface TxMessage {
  type: "tx";
  rev: number;
  txId: string;
  actor: string;
  intent: string | null;
  created: Node[];
  updated: Node[];
  /** Includes the descendants of every deleted Node. */
  deletedIds: string[];
  /** The `id` of the browser command this Transaction answers. */
  commandId?: string;
  /**
   * An undo or redo: Nodes it skipped because they were deleted since (ADR-0011), or would break a
   * tree rule or be a second Clipping Path (ADR-0072).
   */
  skippedIds?: string[];
}

/**
 * Sent only to the browser whose command changed nothing, or, with `id` "", whose socket the
 * Document refuses before it closes it.
 */
export interface RejectedMessage {
  type: "rejected";
  id: string;
  error: ErrorData;
}

export type ServerMessage = DocumentMessage | TxMessage | RejectedMessage;

/** A socket closes with this after its User's Role changed; the browser reconnects (ADR-0047). */
export const ACCESS_CHANGED = 4003;
/** Every socket of a deleted Document closes with this; the browser stops. */
export const DOC_DELETED = 4004;
/** A socket past the Document's connection Quota closes with this; the browser stops (ADR-0048). */
export const TOO_MANY_CONNECTIONS = 4029;

/** One gesture, as one core edit. Parsed by the Document DO: browsers are not trusted. */
export const ClientMessage = z.object({
  type: z.literal("command"),
  id: z.string().max(64),
  command: z.discriminatedUnion("type", [
    // A path the Pen finished drawing (ADR-0032); images come by Place, over HTTP.
    z.object({ type: z.literal("create"), nodes: z.array(NodeInput).min(1).max(1000) }),
    z.object({ type: z.literal("transform"), input: TransformInput }),
    z.object({ type: z.literal("delete"), nodeIds: z.array(z.string()).min(1) }),
    z.object({
      type: z.literal("update"),
      nodeId: z.string(),
      // One Layers panel toggle (ADR-0012); an empty patch would commit a no-op Transaction.
      patch: Writable.pick({ visible: true }).or(Writable.pick({ locked: true })),
    }),
    // Object > Embed: the linked Images with pixels, embedded in one Transaction (ADR-0042).
    z.object({ type: z.literal("embed"), nodeIds: z.array(z.string()).min(1) }),
    // Object > Arrange (ADR-0074).
    z.object({ type: z.literal("reorder"), nodeIds: z.array(z.string()).min(1), op: ReorderOp }),
    // A drag in the Layers panel (ADR-0075).
    z.object({ type: z.literal("reparent"), moves: z.array(ReparentInput).min(1) }),
    // Object > Clipping Mask > Make and Release (ADR-0021).
    z.object({ type: z.literal("mask_make"), input: MaskInput }),
    z.object({ type: z.literal("mask_release"), nodeIds: z.array(z.string()).min(1) }),
    // Direct Selection and continuing a path with the Pen (ADR-0032).
    z.object({ type: z.literal("path_edit"), input: PathEditInput }),
    // Object > Shape > Expand Shape (ADR-0032).
    z.object({ type: z.literal("path_op"), input: PathOpInput }),
    // The Pen continuing a path onto another's Endpoint: the edit, then a Join, as one
    // Transaction (ADR-0037).
    z.object({ type: z.literal("path_join"), edit: PathEditInput, join: PathOpInput }),
    z.object({ type: z.literal("undo") }),
    z.object({ type: z.literal("redo") }),
  ]),
});
export type ClientMessage = z.input<typeof ClientMessage>;
export type Command = ClientMessage["command"];

/** `doc` with `msg` applied, as a new object; `doc` is left untouched. */
export function applyBroadcast(doc: Document, msg: TxMessage): Document {
  const nodes = new Map(doc.nodes);
  for (const n of [...msg.created, ...msg.updated]) nodes.set(n.id, n);
  for (const id of msg.deletedIds) nodes.delete(id);
  return { ...doc, rev: msg.rev, nodes };
}
