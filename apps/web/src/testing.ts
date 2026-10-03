import type { Command, ServerMessage } from "@kalamo/sync";
import type { Renumbering } from "./direct.ts";
import { receive, type ViewState } from "./receive.ts";
import { record } from "./store.ts";

/** A mock `send` that records each command as `id`, as the real `send` records it. */
export const recordAs = (id: string) => (c: Command, _w?: unknown, known?: Renumbering) =>
  record(id, c, known);

/** A test's ViewState: no Document, nothing selected or in flight, until `over` says otherwise. */
export const viewState = (over: Partial<ViewState> = {}): ViewState => ({
  doc: null,
  selection: [],
  isolated: null,
  layerRows: [],
  drag: null,
  pen: null,
  penPress: null,
  pending: [],
  edit: null,
  reversing: null,
  renumbering: new Map(),
  held: [],
  grab: null,
  sentPreviews: [],
  sent: new Set(),
  opPreview: null,
  anchors: [],
  segments: [],
  notice: null,
  paintPreview: null,
  peers: new Map(),
  live: false,
  role: null,
  tool: "selection",
  actorNames: new Map(),
  asked: new Set(),
  areas: new Map(),
  ...over,
});

type Message<K extends ServerMessage["type"]> = Extract<ServerMessage, { type: K }>;

const MESSAGES: { [K in ServerMessage["type"]]: Message<K> } = {
  document: {
    type: "document",
    rev: 0,
    name: "Doc",
    artboards: [],
    nodes: [],
    role: "owner",
    peers: [],
  },
  tx: {
    type: "tx",
    rev: 1,
    txId: "t",
    actor: "agent-a",
    intent: null,
    created: [],
    updated: [],
    deletedIds: [],
    bounds: null,
  },
  staged: { type: "staged", txId: "t", actor: "agent-a", intent: null, bounds: null },
  rejected: {
    type: "rejected",
    id: "c1",
    error: { code: "INVALID_PATH", message: "no", hint: "" },
  },
  presence: { type: "presence", peer: "p", actor: "user_bob", cursor: null },
  joined: { type: "joined", peer: "p", actor: "user_bob" },
  left: { type: "left", peer: "p" },
};

/** A test's server message of `type`, its fields from `over` or a default. */
export const message = <K extends ServerMessage["type"]>(
  type: K,
  over: Partial<Message<K>> = {},
): Message<K> => ({ ...MESSAGES[type], ...over });

/** What `receive` changes in `s` for Document "d", leaving out its effects. */
export const stateAfter = (s: ViewState, msg: ServerMessage, now = 0) =>
  receive(s, msg, "d", now).state;
