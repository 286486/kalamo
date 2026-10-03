import {
  type Artboard,
  type Document,
  DuplicateInput,
  type ErrorData,
  Fill,
  MaskInput,
  type Node,
  NodeInput,
  PathEditInput,
  PathOpInput,
  PathShape,
  type Rect,
  ReorderOp,
  ReparentInput,
  Stroke,
  SubpathRef,
  TransformInput,
  Writable,
} from "@kalamo/core";
import { z } from "zod";
import type { Role } from "./index.ts";

/**
 * Browser wire protocol: the Document on connect, then one `tx` per commit (ADR-0009). A browser
 * sends each gesture as a command and gets its `tx` or a `rejected` back (ADR-0010). Presence is
 * relayed between the sockets of a Document, never stored (ADR-0090).
 */

/** One connection to a Document, and the Actor it is (ADR-0090). */
export interface Peer {
  peer: string;
  actor: string;
}

/** Sent once, right after the WebSocket is accepted. */
export interface DocumentMessage {
  type: "document";
  rev: number;
  name: string;
  artboards: Artboard[];
  nodes: Node[];
  /** The socket's Role: a viewer's commands are rejected (ADR-0047). */
  role: Role;
  /** Every other open socket of the Document. */
  peers: Peer[];
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
  /** The WriteReceipt's `bounds`: where the Transaction changed the Document (ADR-0090). */
  bounds: Rect | null;
  /** The `id` of the browser command this Transaction answers. */
  commandId?: string;
  /**
   * An undo or redo: Nodes it skipped because they were deleted since (ADR-0011), or would break a
   * tree rule or be a second Clipping Path (ADR-0072).
   */
  skippedIds?: string[];
}

/**
 * A write staged in an open Transaction: where it changed the Transaction's view, never its Nodes,
 * which every browser gets in one `tx` at tx_commit (ADR-0090).
 */
export interface StagedMessage {
  type: "staged";
  txId: string;
  actor: string;
  intent: string | null;
  bounds: Rect | null;
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

/** Another Peer's pointer and, when it changed, Selection, as that browser sent it. */
export interface PresenceMessage extends Peer {
  type: "presence";
  /** The pointer in document coordinates (pt), or null off the canvas or in a hidden tab. */
  cursor: { x: number; y: number } | null;
  /** Left out when the Selection has not changed since the Peer's last message. */
  selection?: string[];
}

/** A socket the Document accepted after this one's. */
export interface JoinedMessage extends Peer {
  type: "joined";
}

/** A socket that closed. */
export interface LeftMessage {
  type: "left";
  peer: string;
}

export type ServerMessage =
  | DocumentMessage
  | TxMessage
  | StagedMessage
  | RejectedMessage
  | PresenceMessage
  | JoinedMessage
  | LeftMessage;

/** A browser sends at most one presence message per this many ms (ADR-0090). */
export const PRESENCE_INTERVAL = 50;

/** A socket closes with this after its User's Role changed; the browser reconnects (ADR-0047). */
export const ACCESS_CHANGED = 4003;
/** Every socket of a deleted Document closes with this; the browser stops. */
export const DOC_DELETED = 4004;
/** A socket past the Document's connection Quota closes with this; the browser stops (ADR-0048). */
export const TOO_MANY_CONNECTIONS = 4029;

/** One gesture, as one core edit. Parsed by the Document DO: browsers are not trusted. */
const CommandMessage = z.object({
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
    // The Gradient panel and Gradient tool: each Node's Fills or Strokes, in one Transaction,
    // parsed as node_update's (ADR-0081).
    z.object({
      type: z.literal("appearance"),
      updates: z
        .array(
          z.object({
            nodeId: z.string(),
            appearance: z
              .strictObject({ fills: z.array(Fill), strokes: z.array(Stroke) })
              .partial()
              .refine((a) => a.fills || a.strokes, "Give fills or strokes."),
          }),
        )
        .min(1),
    }),
    // Object > Embed: the linked Images with pixels, embedded in one Transaction (ADR-0042).
    z.object({ type: z.literal("embed"), nodeIds: z.array(z.string()).min(1) }),
    // Object > Arrange (ADR-0074).
    z.object({ type: z.literal("reorder"), nodeIds: z.array(z.string()).min(1), op: ReorderOp }),
    // A drag in the Layers panel (ADR-0075).
    z.object({ type: z.literal("reparent"), moves: z.array(ReparentInput).min(1) }),
    // A Selection-tool drag released with Alt: copies instead of moving (ADR-0076).
    z.object({ type: z.literal("duplicate"), input: DuplicateInput }),
    // Object > Clipping Mask > Make and Release (ADR-0021).
    z.object({ type: z.literal("mask_make"), input: MaskInput }),
    z.object({ type: z.literal("mask_release"), nodeIds: z.array(z.string()).min(1) }),
    // Direct Selection and continuing a path with the Pen (ADR-0032).
    z.object({ type: z.literal("path_edit"), input: PathEditInput }),
    // The Attributes panel (ADR-0108): the fill rule of several paths, and the direction of
    // several subpaths, each in one Transaction. `path_reverse` reverses only the subpaths that do
    // not already run the way `clockwise` names on screen when it is applied (ADR-0109).
    z.object({
      type: z.literal("fill_rule"),
      nodeIds: z.array(z.string()).min(1),
      fillRule: PathShape.shape.fillRule.unwrap(),
    }),
    z.object({
      type: z.literal("path_reverse"),
      subpaths: z.array(SubpathRef).min(1),
      clockwise: z.boolean(),
    }),
    // Object > Shape > Expand Shape (ADR-0032).
    z.object({ type: z.literal("path_op"), input: PathOpInput }),
    // The Pen continuing a path onto another's Endpoint: the edit, then a Join, as one
    // Transaction (ADR-0037).
    z.object({ type: z.literal("path_join"), edit: PathEditInput, join: PathOpInput }),
    z.object({ type: z.literal("undo") }),
    z.object({ type: z.literal("redo") }),
  ]),
});

/** The pointer and Selection, relayed to the other Peers. A viewer may send it (ADR-0090). */
const PresenceInput = z.object({
  type: z.literal("presence"),
  // z.number() refuses Infinity and NaN.
  cursor: z.object({ x: z.number(), y: z.number() }).nullable(),
  selection: z.array(z.string().max(64)).max(1000).optional(),
});

export const ClientMessage = z.discriminatedUnion("type", [CommandMessage, PresenceInput]);
export type ClientMessage = z.input<typeof ClientMessage>;
export type Command = z.input<typeof CommandMessage>["command"];

/** `doc` with `msg` applied, as a new object; `doc` is left untouched. */
export function applyBroadcast(doc: Document, msg: TxMessage): Document {
  const nodes = new Map(doc.nodes);
  for (const n of [...msg.created, ...msg.updated]) nodes.set(n.id, n);
  for (const id of msg.deletedIds) nodes.delete(id);
  return { ...doc, rev: msg.rev, nodes };
}
