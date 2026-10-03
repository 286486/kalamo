import {
  type BareAnchor,
  type Document,
  type DuplicateInput,
  duplicateNodes,
  editPath,
  type Geometry,
  type NodeInput,
  outermost,
  type PathEditInput,
  paintOrder,
  pathOp,
  transformNodes,
} from "@kalamo/core";
import { applyBroadcast, type Command, type Role, type ServerMessage } from "@kalamo/sync";
import type { CurveAnchor } from "./curvature.ts";
import {
  anchorKey,
  fits,
  hasAnchors,
  inRange,
  localAnchors,
  parseKey,
  type Renumbering,
  renumberInput,
  renumberingOf,
  renumberKey,
  renumberTarget,
  replaceSubpath,
  reversedKey,
  segmentInRange,
  type Target,
  targetKeys,
  targetNode,
  turnedOf,
  turnInput,
  turnTarget,
} from "./direct.ts";
import type { PaintPreview } from "./gradient.ts";
import { prune } from "./isolation.ts";
import { type Areas, areasAfter, type Peers, peersAfter } from "./presence.ts";
import { editable, objects } from "./selection.ts";
import type { NodeOp } from "./store.ts";
import type { Tool } from "./toolbox.ts";

/**
 * The Selection being dragged by (dx, dy) pt. `commandId` is set once its move has been sent, in
 * `sentPreviews`; the live slot `drag` holds one not yet sent. With `copy`, Alt held, it leaves the
 * originals and drops copies (ADR-0076); `leave` is the Isolation move its answer makes, as a
 * PendingCreate's.
 */
export interface Drag {
  nodeIds: string[];
  dx: number;
  dy: number;
  commandId: string | null;
  copy?: boolean;
  leave?: PendingCreate["leave"];
}

/** An open subpath's Endpoint: its first Anchor, or its last. */
export interface Endpoint {
  nodeId: string;
  subpath: number;
  atStart: boolean;
}

/** `e`'s Anchor as a Direct Selection key, which a Reverse Path Direction press's answer renumbers. */
export function endKey(doc: Document, e: Endpoint) {
  const n = doc.nodes.get(e.nodeId);
  const count = n && hasAnchors(n) ? (localAnchors(n)[e.subpath]?.anchors.length ?? 0) : 0;
  return anchorKey(e.nodeId, e.subpath, e.atStart ? 0 : count - 1);
}

/** The Endpoint whose Anchor `key` names. */
export function endOf(key: string): Endpoint {
  const { nodeId, subpath, index } = parseKey(key);
  return { nodeId, subpath, atStart: index === 0 };
}

/** A Rectangle or Ellipse dragged out, in document coordinates. */
export interface ShapeBox {
  type: "rect" | "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
  /** A rect's corner radius, 0 when left out. */
  radius?: number;
}

/**
 * The path the Pen or Curvature tool is drawing, in document coordinates (ADR-0032). It stays in
 * the browser until finished, then is sent as a PendingCreate.
 */
export interface PenPath {
  anchors: BareAnchor[];
  /**
   * The path the Pen continues from its Endpoint: `anchors` start with its subpath's `kept` Anchors
   * as drawn, turned to end at that Endpoint. `to` is another path's Endpoint the last Anchor
   * connects to, as drawn. Each `seed` is what its path as drawn is built on: the person's sent,
   * unanswered edits to it, by command id (#293), and their held edits to it, by token (#308).
   */
  from?: Endpoint & { kept: number; seed?: string[] };
  to?: Endpoint & { seed?: string[] };
  /** The Curvature tool's Anchors as placed, which `anchors` follow. */
  curve?: CurveAnchor[];
  closed: boolean;
}

/**
 * The Pen's press while its button is down: on the Anchor of `pen` at `index`, with the pointer's
 * last position. It is one just placed, the last Anchor pressed again, the first Anchor, which
 * closes the path on release, or another path's Endpoint, which `pen.to` names and the release
 * connects to; once that connection is dropped (#290), the press is inert until release. `broken`
 * is set once Alt broke the Handles, which stay broken for the rest of the press. It lives beside
 * `pen`, so whatever drops the connection changes both in one step.
 */
export interface PenPress {
  kind: "place" | "last" | "close" | "connect" | "dropped";
  index: number;
  at: [number, number];
  broken?: boolean;
}

/**
 * A drawing tool's `create`, sent and drawn until its own answer arrives (ADR-0032); or, with no
 * `nodes`, a Layers panel Alt-drag's `duplicate`, whose answer selects its copies (ADR-0075).
 */
export interface PendingCreate {
  commandId: string;
  nodes: NodeInput[];
  /** Whether its `tx` selects what it created: false for the Pencil with Keep selected off. */
  select: boolean;
  /** Sent from an isolated leaf `from`: the level `to` go up to once its `tx` creates it (#137). */
  leave?: { from: string; to: string | null };
}

/**
 * A Direct Selection drag: one `path_edit` per path. `commandIds`, one per input, is set once they
 * are sent, in `sentPreviews`; the live slot `edit` holds one not yet sent. Each answer or rejection
 * takes its paths out, and the preview lasts until the last one. One command may answer several
 * inputs, as the Attributes panel's `path_reverse` does.
 */
export interface PathDrag {
  inputs: PathEditInput[];
  commandIds: string[] | null;
}

/**
 * A `path_reverse` in flight, the subpaths it names, and its preview, drawn on the Document's
 * canvas only. The keys stay numbered as `doc` runs until its answer renumbers them, and Direct
 * Selection edits wait for it (ADR-0110). Kept apart from `edit`, which the next Direct Selection
 * action replaces.
 */
export interface Reversing {
  commandId: string;
  subpaths: { nodeId: string; subpath: number }[];
  /** The direction pressed, which the Attributes panel shows until the answer. */
  clockwise: boolean;
  inputs: PathEditInput[];
}

/**
 * What a Direct Selection edit acts on, as the person had chosen it when they made the edit. An
 * edit on one Anchor, Handle or segment names it as `target`, and its keys are `target`'s; held, the
 * answer turns `target` by the rule that renumbers the keys, and it goes when they go (ADR-0110).
 */
export type Chosen = Pick<ViewState, "anchors" | "segments" | "selection" | "tool"> & {
  target?: Target;
  /** Whose change took away keys it was chosen on, the first time one went (#293). */
  lostBy?: Cause;
};

/** One edit's preview: the paths it reshapes and the Nodes it moves whole. */
export type Preview = Pick<ViewState, "edit" | "drag">;

/**
 * A sent edit's preview, its `edit` and `drag` carrying the command ids whose answers settle it.
 * `fromHeld` marks a held edit that ran: its keys were worked out for it, not for a drag started
 * later, so its answer does not keep what that drag holds (ADR-0110).
 */
export type SentPreview = Preview & { fromHeld?: true };

/**
 * What a held `set_d` edit sends, worked out on the path as its run sees it and its keys: a Pencil
 * redraw's or a Pen finish's input, and the command that carries it when it is not a `path_edit`
 * of it alone; or the notice it is dropped with (#286).
 */
export type Redraw = (
  doc: Document,
  chosen: Chosen,
) => { input: PathEditInput; command?: Command } | string;

/**
 * A Direct Selection edit made while a Reverse Path Direction press was in flight, run once it is
 * answered (ADR-0110). Its keys are renumbered and cleared as the Direct Selection's are meanwhile.
 * `preview` is its own, drawn until it runs: running or dropping it changes no other preview. An
 * answer that renumbers its keys moves its preview with them, or, with `redraw`, works it out again
 * (#286).
 */
export interface Held {
  chosen: Chosen;
  run: (chosen: Chosen) => void;
  preview: Preview;
  /**
   * A `set_d` edit's input, which its run sends and its preview draws (#286), and its tool's
   * notices for a drop of what it drew, by cause (#309). Only `afterRedraw` sets it.
   */
  redraw?: { run: Redraw; dropped: Record<Cause, string> };
  /** An Anchor Point drag out of an Anchor, whose Handles a turn leaves as they are (#286). */
  pulled?: true;
  /**
   * Names it in what is drawn on its preview until it runs: a seed then holds the ids it sent in its
   * place, or goes with it if it sent nothing (#308).
   */
  token: string;
  /**
   * What a Pen finish or a Pencil redraw was drawn on (`seedOf`): it waits for their answers, and a
   * rejection of one, or a held edit named that sends nothing, drops it (#293, #308, #309).
   */
  seed?: string[];
}

/**
 * Object > Path > Simplify or Offset Path while its bar or dialog is open: previewed in the
 * browser, then sent as one `path_op` on OK (ADR-0035); `commandId` is set then, and it is drawn
 * until the answer.
 */
export interface PathOpPreview {
  input: NodeOp;
  /** Simplify's Show Original Path. */
  showOriginal: boolean;
  commandId: string | null;
  /** PathKit, which Offset Path's preview needs (ADR-0034). */
  geometry?: Geometry;
}

export interface ViewState {
  doc: Document | null;
  /** UI state only, never sent as a Document property (CONTEXT.md). */
  selection: string[];
  /** The isolated Node (ADR-0057, ADR-0058): UI state, like the Selection. */
  isolated: string | null;
  /**
   * The Layer rows the Layers panel shows selected, whose objects are in the Selection, since a
   * Layer never is (ADR-0012). Only a write that sets them keeps them across a Selection change.
   */
  layerRows: string[];
  /**
   * The live gesture's unsent preview, with `edit`: the Nodes it moves whole. Once sent, it is drawn
   * from `sentPreviews` until its answer, so a committed move does not flicker.
   */
  drag: Drag | null;
  pen: PenPath | null;
  penPress: PenPress | null;
  /** Drawn art sent and not yet answered, oldest first. */
  pending: PendingCreate[];
  /** The live gesture's unsent preview, with `drag`: the paths it reshapes. */
  edit: PathDrag | null;
  reversing: Reversing | null;
  /**
   * The person's other commands sent and unanswered that may renumber a path's Anchors, by id, and
   * how each renumbers its path, or null when the browser cannot tell. Edits by index wait for them
   * as for `reversing` (#298).
   */
  renumbering: ReadonlyMap<string, Renumbering | null>;
  /** Direct Selection edits waiting for the answers to `reversing` and `renumbering`, oldest first. */
  held: Held[];
  /**
   * What a drag still being made holds by index: Direct Selection's Anchors, or the one Anchor,
   * Handle or segment a tool grabbed. The answer to a Reverse Path Direction press renumbers it;
   * another Actor's edit to a path drops what it holds there (ADR-0110).
   */
  grabbed: Target[];
  /**
   * The preview of the drag still being made, worked out from a Document and what it holds as its
   * next move works it out; null while it has none. Whatever turns, renumbers or lets go of
   * `grabbed` redraws the preview with it, so it stays the one the next move draws (#285).
   */
  regrab: ((doc: Document, grabbed: Target[]) => Partial<Preview> | null) | null;
  /**
   * Every sent edit's preview, in the order sent, each drawn until the answers to its command ids:
   * a live gesture's and a held edit's alike. A command with no preview is in `sent` only (#285).
   */
  sentPreviews: SentPreview[];
  /**
   * Every command this tab sent on an open socket and has not yet had answered, with a `tx` or a
   * `rejected`: a `tx` whose `commandId` is here is the person's own; any other, another Actor's,
   * another tab's included (ADR-0109).
   */
  sent: ReadonlySet<string>;
  opPreview: PathOpPreview | null;
  /** Direct Selection's selected Anchors (direct.ts's keys): UI state, like the Selection. */
  anchors: string[];
  /** Its selected segments, keyed by the Anchor each starts at (ADR-0045). */
  segments: string[];
  /** Why the last command was rejected. */
  notice: string | null;
  /** The Gradient panel's or tool's paints, drawn until their answer (ADR-0081). */
  paintPreview: PaintPreview | null;
  /** The Document's other connections, whose cursors and Selections are drawn (ADR-0090). */
  peers: Peers;
  /** False while the socket is down; the last Document stays on screen. */
  live: boolean;
  /** The shown Document's Role, from the socket (ADR-0047); null until it connects. */
  role: Role | null;
  tool: Tool;
  /** The shown Document's Actors' names, by Actor id, from its Actor rows (ADR-0090). */
  actorNames: ReadonlyMap<string, string>;
  /** The Actors this socket fetched the names for, at most once each; a fetch gets them all. */
  asked: ReadonlySet<string>;
  /** Each Actor's last write, drawn as an Agent's Working Area (ADR-0090). */
  areas: Areas;
}

/** The tools a viewer keeps, which change nothing; Space pans as the Hand for everyone. */
export const VIEWER_TOOLS: readonly Tool[] = ["selection", "zoom"];

/** What a server message asks of the socket, beyond its ViewState. */
export type Effect =
  /**
   * A new socket is a new Peer to the others: it sends its presence in full; and so does every
   * socket when one joins, which asks for it (ADR-0090).
   */
  | { type: "resend-presence" }
  /** Fetch the Document's Actor rows, for these Actors' names. */
  | { type: "fetch-names"; actors: string[] }
  /** A missed `rev`: reconnect for the whole Document. */
  | { type: "reconnect" };

/**
 * The ViewState after one server message that arrived at `now` (ADR-0009, ADR-0010), and what it
 * asks of the socket.
 */
export function receive(
  s: ViewState,
  msg: ServerMessage,
  docId: string,
  now: number,
): { state: Partial<ViewState>; effects: Effect[] } {
  const snapshot = msg.type === "document" ? msg : null;
  const effects: Effect[] = [];
  if (snapshot || msg.type === "joined") effects.push({ type: "resend-presence" });
  const unseen =
    msg.type === "presence" || msg.type === "joined" || msg.type === "tx" || msg.type === "staged"
      ? [msg.actor].filter((a) => !s.asked.has(a) && !s.actorNames.has(a))
      : [];
  // Each Document asks for every Peer's name again.
  const actors = snapshot ? snapshot.peers.map((p) => p.actor) : unseen;
  if (snapshot || actors.length > 0) effects.push({ type: "fetch-names", actors });
  const asked = snapshot
    ? { asked: new Set(actors) }
    : actors.length > 0 && { asked: new Set([...s.asked, ...actors]) };
  const view = viewAfter(s, msg, docId);
  if (!view) return { state: { ...asked }, effects: [...effects, { type: "reconnect" }] };
  const peers = peersAfter(s.peers, msg);
  const areas = areasAfter(s.areas, msg, now);
  const viewer = snapshot?.role === "viewer" && !VIEWER_TOOLS.includes(s.tool);
  return {
    state: {
      ...view,
      ...asked,
      ...(peers !== s.peers && { peers }),
      ...(areas !== s.areas && { areas }),
      ...(snapshot && { live: true, role: snapshot.role }),
      ...(viewer && { tool: "selection" }),
    },
    effects,
  };
}

/**
 * Why a Pen finish was not applied: the two paths it joins moved apart, by whoever's edit, seen
 * before it was sent or by the Document DO's `ENDPOINTS_APART` after (ADR-0111).
 */
export const PEN_MOVED =
  "A path the Pen was connecting to moved before the connection was made; what it drew was not applied.";

/**
 * Whose change a message brings to a Node: the person's own command's, another Actor's, or none,
 * since the person's own edit the Pen drew on was not applied (#293).
 */
export type Cause = "own" | "other" | "unapplied";

/** Why a continuation ended, by whose change (ADR-0110, #293). */
const PEN_STOPPED: Record<Cause, string> = {
  own: "Your own earlier change reshaped the path the Pen was continuing; the Pen stopped, and what it drew was not applied.",
  other:
    "Someone else changed the path the Pen was continuing; the Pen stopped, and what it drew was not applied.",
  unapplied:
    "Your earlier edit to the path the Pen was continuing was not applied, so what the Pen drew was not applied.",
};

/** Why a connection was dropped, by whose change (#290, #293). */
const PEN_DISCONNECTED: Record<Cause, string> = {
  own: "Your own earlier change reshaped the path the Pen was connecting to; the connection was not made.",
  other: "Someone else changed the path the Pen was connecting to; the connection was not made.",
  unapplied:
    "Your earlier edit to the path the Pen was connecting to was not applied, so the connection was not made.",
};

/** Why a held Pen finish sent nothing: a change to a path it continued or met, by whose (#293). */
export const PEN_DROPPED: Record<Cause, string> = {
  own: "Your own earlier change reshaped a path the Pen was continuing or connecting to; what it drew was not applied.",
  other:
    "Someone else changed a path the Pen was continuing or connecting to; what it drew was not applied.",
  unapplied:
    "Your earlier edit to a path the Pen was continuing or connecting to was not applied, so what the Pen drew was not applied.",
};

/**
 * What a message leaves of something the person holds on a Node it touched (#293). "renumbered"
 * keeps as "keeps" does; it says the answer's `Renumbering` moves it.
 */
type Fate = "keeps" | "renumbered" | "ends";

/**
 * On one Node a message touched, whose change it was, and what it leaves of: the Direct Selection's
 * keys and a held edit's, each kept or renumbered while still in range; a held Pen finish's drawn on
 * the person's sent edits (`seeded`); what a drag still being made holds (`grabbed`); a Pen
 * continuation; and a Pen connection.
 */
type Fates = Record<
  "keys" | "held" | "seeded" | "grabbed" | "continuation" | "connection",
  Fate
> & { cause: Cause };

/**
 * How the person's own command `msg` renumbers its path, and whose change it was and what it leaves
 * on each Node it touched, or null for a Node it left alone; a Document sent on reconnect touches
 * every Node and is read as another Actor's, since it says nothing of who changed what (ADR-0109,
 * ADR-0110), unless the Node is as it was, so only the person's own edits the Pen drew on were not
 * applied (#293).
 *
 * Another Actor's change to a Node ends all of it. The person's own command that leaves a Node's
 * geometry as it was keeps it; one that reshapes it ends it, but what was worked out for that
 * command (#288): the keys and a connection keep through the answer to any of the person's sent
 * previews; a drag still being made, only through its own earlier drags', not a held edit's that
 * ran; a continuation, only through the press's and those of the edits its Anchors were drawn on
 * (#293). The answer to a command the browser can number renumbers the keys and what a drag holds
 * on its path instead (#298).
 *
 * A reconnect reads geometry (#287): a Node changed while the socket was down when its geometry is
 * neither as it was nor as the press leaves it. Keys go on such a path the press names (#276), or on
 * any while another renumbering command is unanswered (#298); a held edit's and a drag's on any. The
 * Pen holds its Anchors and Endpoints where the person saw them, so a continuation, a connection and
 * a held finish drawn on the person's sent edits end when their path is not as drawn then; a
 * continuation, moved included.
 */
function classify(
  s: ViewState,
  msg: Extract<ServerMessage, { type: "tx" | "document" }>,
  prior: Document | null,
  doc: Document,
): { map: Renumbering | null; fates: (n: string) => Fates | null } {
  if (msg.type === "document") {
    const changedSince = (before: Document | null) => {
      const pressedThen = before && s.reversing ? previewEdit(before, s.reversing) : before;
      return (n: string) =>
        geometryOf(before, n) !== geometryOf(doc, n) &&
        geometryOf(pressedThen, n) !== geometryOf(doc, n);
    };
    const reshaped = changedSince(prior);
    // A held edit was never sent, so the Document cannot have it.
    const seen = prior && asDrawn(prior, { ...s, held: [] });
    const redrawn = changedSince(seen);
    const placed = (n: string) =>
      String(seen?.nodes.get(n)?.transform) !== String(doc.nodes.get(n)?.transform);
    const pressNamed = new Set(s.reversing?.subpaths.map((t) => t.nodeId));
    const fate = (ends: boolean): Fate => (ends ? "ends" : "keeps");
    const same = (n: string) =>
      geometryOf(prior, n) === geometryOf(doc, n) &&
      String(prior?.nodes.get(n)?.transform) === String(doc.nodes.get(n)?.transform);
    return {
      map: null,
      fates: (n) => ({
        cause: same(n) ? "unapplied" : "other",
        keys: fate(reshaped(n) && (pressNamed.has(n) || s.renumbering.size > 0)),
        held: fate(reshaped(n)),
        seeded: fate(redrawn(n)),
        grabbed: fate(reshaped(n)),
        continuation: fate(redrawn(n) || placed(n)),
        connection: fate(redrawn(n)),
      }),
    };
  }
  const id = msg.commandId;
  const press = !!id && id === s.reversing?.commandId;
  const answers = (previews: Preview[]) =>
    press ||
    (!!id && previews.some((p) => p.drag?.commandId === id || !!p.edit?.commandIds?.includes(id)));
  const previewed = answers(s.sentPreviews);
  const cause = previewed || (!!id && s.sent.has(id)) ? "own" : "other";
  const numbered = id ? s.renumbering.get(id) : undefined;
  const map = numbered && fits(prior, numbered) ? numbered : null;
  const touched = new Set([...msg.updated.map((n) => n.id), ...msg.deletedIds]);
  const forDrag = answers(s.sentPreviews.filter((p) => !p.fromHeld));
  const forPen = press || (!!id && !!s.pen?.from?.seed?.includes(id));
  return {
    map,
    fates: (n) => {
      if (!touched.has(n)) return null;
      const kept = cause === "own" && geometryOf(prior, n) === geometryOf(doc, n);
      const fate = (forIt: boolean, numbers = false): Fate =>
        numbers && map?.nodeId === n ? "renumbered" : forIt || kept ? "keeps" : "ends";
      return {
        cause,
        keys: fate(previewed, true),
        held: fate(previewed, true),
        seeded: fate(previewed, true),
        grabbed: fate(forDrag, true),
        continuation: fate(forPen),
        connection: fate(previewed),
      };
    },
  };
}

/** The Document, Selection and previews after one server message, or null after a missed `rev`. */
function viewAfter(s: ViewState, msg: ServerMessage, docId: string): Partial<ViewState> | null {
  // Presence changes no Document state (ADR-0090); nor, yet, does an Agent's staged area.
  if (
    msg.type === "presence" ||
    msg.type === "joined" ||
    msg.type === "left" ||
    msg.type === "staged"
  )
    return {};
  if (msg.type === "rejected") {
    const { code } = msg.error;
    const sent = settleSent(s.sent, msg.id);
    const sentPreviews = settleSentPreviews(s.sentPreviews, msg.id);
    // What the Pen drew on the person's rejected edit would write it back, so it goes (#293).
    const gone = dropDrawnOn({ ...s, ...sent, ...sentPreviews }, [msg.id]);
    return {
      ...sent,
      ...gone.state,
      ...(s.reversing?.commandId === msg.id && { reversing: null }),
      ...settleRenumbering(s.renumbering, msg.id),
      ...settlePending(s.pending, msg.id),
      ...(s.opPreview?.commandId === msg.id && { opPreview: null }),
      ...(s.paintPreview?.commandId === msg.id && { paintPreview: null }),
      ...sentPreviews,
      notice: joinNotices([
        code === "NODE_GONE"
          ? "Someone else deleted that object first; it stays deleted."
          : code === "ENDPOINTS_APART"
            ? PEN_MOVED
            : msg.error.message,
        ...gone.notices,
      ]),
    };
  }
  let doc: Document;
  if (msg.type === "document") {
    const { rev, name, artboards, nodes } = msg;
    doc = {
      id: docId,
      name,
      version: 1,
      rev,
      artboards,
      nodes: new Map(nodes.map((n) => [n.id, n])),
      // The canvas fetches image files by id; it never needs their metadata (ADR-0023).
      images: new Map(),
    };
  } else if (s.doc && msg.rev === s.doc.rev + 1) {
    doc = applyBroadcast(s.doc, msg);
  } else {
    return null;
  }
  const drawn =
    msg.type === "tx" ? s.pending.find((p) => p.commandId === msg.commandId) : undefined;
  const id = msg.type === "tx" ? msg.commandId : undefined;
  const prior = s.doc;
  const { map, fates } = classify(s, msg, prior, doc);
  const ends = (n: string | undefined, what: Exclude<keyof Fates, "cause">) =>
    !!n && fates(n)?.[what] === "ends";
  const causeOf = (n: string | undefined) => (n && fates(n)?.cause) || "other";
  // The press's answer, or the Document sent on reconnect, settles it: keys on a subpath it turned
  // are renumbered to stay on their points (ADR-0110).
  const settled =
    !!s.reversing && (msg.type === "document" || msg.commandId === s.reversing.commandId);
  // A reconnect loses the answers to the commands in flight, so their previews go; the live
  // gesture's unsent preview stays while what it holds does (#285).
  const { sentPreviews: sentLeft = s.sentPreviews } =
    msg.type === "document" ? { sentPreviews: [] } : settleSentPreviews(s.sentPreviews, id);
  const sentAfter =
    msg.type === "document" ? new Set<string>() : (settleSent(s.sent, id).sent ?? s.sent);
  // Keys stay on a Node the message left alone; on one it touched, while they keep and are in range
  // on `on`: `doc`, or for a Pen finish, the paths as drawn it numbered its keys on (#308).
  const keptBy =
    (what: "keys" | "held" | "seeded", on = doc) =>
    (inRangeOf: typeof inRange) =>
    (key: string) => {
      const f = fates(parseKey(key).nodeId);
      return !f || (f[what] !== "ends" && inRangeOf(on, key));
    };
  const kept = keptBy("keys");
  const turned =
    settled && prior && s.reversing
      ? turnedOf(
          prior,
          doc,
          s.reversing.subpaths.filter((t) => !ends(t.nodeId, "keys")),
        )
      : [];
  const present = <K>(k: K | null): k is K => k !== null;
  const rekey = (k: Pick<ViewState, "anchors" | "segments">, keep = kept) => ({
    anchors: k.anchors
      .map(reversedKey(doc, turned, false))
      .map(renumberKey(map, false))
      .filter(present)
      .filter(keep(inRange)),
    segments: k.segments
      .map(reversedKey(doc, turned, true))
      .map(renumberKey(map, true))
      .filter(present)
      .filter(keep(segmentInRange)),
  });
  const { anchors, segments } = rekey(s);
  // A held edit's target is turned as its keys are; once a key goes, so does the target. The first
  // change that takes keys away is the one a dropped Pen finish names (#293).
  const rechosen = ({ target, ...c }: Chosen, what: "held" | "seeded", base: Document): Chosen => {
    const heldKept = keptBy(what, base);
    const t = target && renumberTarget(map)(turnTarget(doc, turned)(target));
    const k = t && targetKeys(t);
    const on = k?.anchors.every(heldKept(inRange)) && k.segments.every(heldKept(segmentInRange));
    const next = !target
      ? { ...c, ...rekey(c, heldKept) }
      : t && on
        ? { ...c, ...k, target: t }
        : { ...c, anchors: [], segments: [] };
    const lost = next.anchors.length + next.segments.length < c.anchors.length + c.segments.length;
    const its = [...c.anchors, ...c.segments].map((k) => fates(parseKey(k).nodeId)).filter(present);
    const by = (its.find((f) => f[what] === "ends") ?? its[0])?.cause;
    return lost && !c.lostBy && by ? { ...next, lostBy: by } : next;
  };
  // A change that ends the continuation ends its preview, so its finish never writes the Anchors it
  // started from over that change (ADR-0110). One to the path a press connects to drops only the
  // connection, so the release joins nothing renumbered or deleted (#290).
  const reached = ends(s.pen?.from?.nodeId, "continuation");
  const pen = s.pen && turned.length > 0 ? turnedPen(doc, s.pen, turned) : s.pen;
  const dropped =
    !reached && ends(pen?.to?.nodeId, "connection") && pen ? disconnected(pen, s.penPress) : null;
  // What a drag still being made holds on a path it no longer keeps goes; the rest is turned and
  // renumbered as the keys are (ADR-0110, #298). Its unsent preview is drawn again from what it
  // still holds, as its next move draws it (#285).
  const letGo = new Set(s.grabbed.map(targetNode).filter((n) => ends(n, "grabbed")));
  const grabbed = s.grabbed
    .filter((t) => !letGo.has(targetNode(t)))
    .map(turnTarget(doc, turned))
    .map(renumberTarget(map))
    .filter(present);
  const regrabbed = (turned.length > 0 || letGo.size > 0 || !!map) && s.regrab?.(doc, grabbed);
  const skipped = msg.type === "tx" ? (msg.skippedIds?.length ?? 0) : 0;
  // A selected Node that a browser's command moved into a new Group selects that Group, as Make
  // Clipping Mask does; an Agent's edit leaves the person's Selection alone.
  const made = new Set(msg.type === "tx" && msg.commandId ? msg.created.map((n) => n.id) : []);
  const selection = s.selection.flatMap((id) => {
    const parentId = doc.nodes.get(id)?.parentId;
    if (parentId === undefined) return [];
    return parentId && made.has(parentId) ? [parentId] : [id];
  });
  // What drawn art created, but its inline children: a Group drawn is selected, not its contents.
  const drawnTop =
    msg.type === "tx"
      ? msg.created.filter((n) => !n.parentId || !made.has(n.parentId)).map((n) => n.id)
      : [];
  // An Alt-drag's copies become the Selection, as drawn art does (ADR-0076).
  const moved = id ? s.sentPreviews.find((p) => p.drag?.commandId === id)?.drag : undefined;
  const copied = moved?.copy ? moved : undefined;
  const isolated = prune(s.doc, doc, s.isolated);
  // Drawn art leaves its leaf, unless an Esc, a prune or earlier art moved the Isolation meanwhile.
  const leave = drawn?.leave ?? copied?.leave;
  // Drawn art becomes the Selection, as in Illustrator. A copied Layer is selected as its row is
  // clicked: its row, and its objects unless it is hidden or locked, itself or through an ancestor
  // (ADR-0076).
  const tops = drawn ? (drawn.select ? drawnTop : []) : copied ? drawnTop : null;
  const layers = tops?.filter((id) => doc.nodes.get(id)?.type === "layer") ?? [];
  const next = tops
    ? tops.flatMap((id) => {
        if (!layers.includes(id)) return [id];
        return editable(doc, doc.nodes.get(id)) ? objects(doc, id).map((n) => n.id) : [];
      })
    : [...new Set(selection)];
  // Each held preview follows its keys. A `set_d` one is worked out again in run order, on what its
  // run will see: the paths as drawn with the sent previews and the held ones before it, which a Pen
  // finish's keys are numbered on (#286, #308).
  const renumbers = turned.length > 0 || !!map;
  const held: Held[] = [];
  for (const h of s.held) {
    const base =
      h.seed || (renumbers && h.redraw)
        ? asDrawn(doc, { sentPreviews: sentLeft, sent: sentAfter, held })
        : doc;
    const chosen = {
      ...rechosen(h.chosen, h.seed ? "seeded" : "held", base),
      selection: h.chosen.selection.filter((id) => doc.nodes.has(id)),
    };
    const preview = !renumbers
      ? h.preview
      : h.redraw
        ? redrawn(h.redraw.run(base, chosen))
        : renumberPreview(doc, turned, map, h);
    held.push({ ...h, chosen, preview });
  }
  return {
    doc,
    isolated: leave && isolated === leave.from ? prune(s.doc, doc, leave.to) : isolated,
    // An unchanged Selection stays the same array, so the Layer rows stay (ADR-0076).
    selection: !tops && sameIds(next, s.selection) ? s.selection : next,
    ...(tops && { layerRows: layers }),
    ...(regrabbed && { edit: regrabbed.edit ?? null, drag: regrabbed.drag ?? null }),
    ...(msg.type === "document" ? s.sent.size > 0 && { sent: new Set() } : settleSent(s.sent, id)),
    anchors,
    segments,
    // A continuation the reconnect keeps is drawn again on the new Document (#292).
    ...(msg.type === "document" &&
      pen && { edit: (!reached && penState(doc, pen, null).edit) || null }),
    ...(sentLeft !== s.sentPreviews && { sentPreviews: sentLeft }),
    ...(settled && { reversing: null }),
    ...(pen !== s.pen && { pen }),
    ...(dropped && {
      ...penState(asDrawn(doc, { ...s, sentPreviews: sentLeft }), dropped.pen, s.edit),
      penPress: dropped.penPress,
    }),
    ...((turned.length > 0 || letGo.size > 0 || !!map) && { grabbed }),
    ...(msg.type === "document"
      ? s.renumbering.size > 0 && { renumbering: new Map() }
      : settleRenumbering(s.renumbering, id)),
    ...(s.held.length > 0 && { held }),
    ...(msg.type === "document"
      ? s.pending.length > 0 && { pending: [] }
      : settlePending(s.pending, msg.commandId)),
    ...(s.opPreview?.commandId &&
      (msg.type === "document" || msg.commandId === s.opPreview.commandId) && { opPreview: null }),
    ...(s.paintPreview &&
      (msg.type === "document" || msg.commandId === s.paintPreview.commandId) && {
        paintPreview: null,
      }),
    ...(reached && { pen: null, ...(s.edit && { edit: null }) }),
    ...((reached || dropped || skipped > 0) && {
      notice: joinNotices([
        reached && PEN_STOPPED[causeOf(s.pen?.from?.nodeId)],
        dropped && PEN_DISCONNECTED[causeOf(pen?.to?.nodeId)],
        skipped > 0 &&
          `Skipped ${skipped} object(s) deleted or moved since; they stay as they are.`,
      ]),
    }),
  };
}

/** The notices one message gives, in the order given, each once and none replacing another (#291). */
export const joinNotices = (notices: (string | false | null | undefined)[]) =>
  [...new Set(notices.filter(Boolean))].join(" ");

/**
 * `doc` with the drag applied by core, as the Document DO will apply it. Nodes deleted meanwhile
 * are left out here; the command still names them, so it is rejected (ADR-0010).
 */
export function preview(doc: Document, drag: Drag): Document {
  const shown = { ...doc, nodes: new Map(doc.nodes) };
  const present = drag.nodeIds.filter((id) => doc.nodes.has(id));
  if (present.length === 0) return shown;
  if (!drag.copy) {
    transformNodes(shown, { nodeIds: present, translate: { x: drag.dx, y: drag.dy } });
    return shown;
  }
  try {
    duplicateNodes(shown, copyInput(doc, { ...drag, nodeIds: present }));
    return shown;
  } catch (e) {
    console.warn("An Alt-drag preview skipped a copy core refuses.", e);
    return doc;
  }
}

/**
 * An Alt-drag's copies (ADR-0076), as Illustrator places them: one block directly above the topmost
 * dragged Node, in its parent, moved by the drag. The Nodes are those a plain drag moves, the
 * outermost ones; with a Layer among them each copy goes directly above its own original instead,
 * since a Layer cannot join a Group's block or become a nested Layer by a drag.
 */
export function copyInput(doc: Document, { nodeIds, dx, dy }: Drag): DuplicateInput {
  const offset = { x: dx, y: dy };
  const { kept } = outermost(
    doc,
    nodeIds.flatMap((id) => doc.nodes.get(id) ?? []),
  );
  if (kept.length === 0 || kept.some((n) => n.type === "layer")) return { nodeIds, offset };
  const order = paintOrder(doc);
  const top = kept.reduce((a, b) => ((order.get(b.id) ?? 0) > (order.get(a.id) ?? 0) ? b : a));
  return { nodeIds, offset, targetParentId: top.parentId, after: top.id };
}

/**
 * `doc` with a Direct Selection drag applied by core. Its ops are absolute, so one already
 * committed applies again unchanged; one core refuses, such as on a Node deleted meanwhile, is left
 * out here and rejected by the DO.
 */
export function previewEdit(doc: Document, { inputs }: Pick<PathDrag, "inputs">): Document {
  const shown = { ...doc, nodes: new Map(doc.nodes) };
  for (const input of inputs) {
    try {
      editPath(shown, input);
    } catch (e) {
      console.warn("A Direct Selection preview skipped a path core refuses to edit.", e);
    }
  }
  return shown;
}

/**
 * Every edit's preview, in the order the Document DO applies them: sent edits in the order sent,
 * held edits in the order they will run, then the live gesture's unsent one (ADR-0110).
 */
export const previewsOf = (
  s: Pick<ViewState, "sentPreviews" | "held" | "edit" | "drag">,
): Preview[] => [
  ...s.sentPreviews,
  ...s.held.map((h) => h.preview),
  { edit: s.edit, drag: s.drag },
];

/** `doc` with each preview applied in order: its Nodes moved whole, then its paths reshaped. */
export const previewAll = (doc: Document, previews: Preview[]): Document =>
  previews.reduce((d, { drag, edit }) => {
    const moved = drag ? preview(d, drag) : d;
    return edit ? previewEdit(moved, edit) : moved;
  }, doc);

/**
 * A preview the paths as drawn include, and what it waits on: a sent command's id, or a held edit's
 * token until it runs (#308).
 */
export type DrawnOn = Preview & { on: string };

/**
 * What the paths as drawn are built on, in the order the Document DO will apply it (#293, #308): the
 * person's sent, unanswered edits and Selection tool moves, one entry per command, then their held
 * edits' previews, in the order they will run. An edit counts only while `sent` records it: one
 * dropped while the socket was down is never applied, so the Pen must not write it back. An
 * Alt-drag's copies are left out: they are not in the Document until its answer, so nothing can be
 * continued or joined on them. The live slots are the gesture being made, not what it is drawn on.
 */
export const drawnOn = (s: Pick<ViewState, "sentPreviews" | "sent" | "held">): DrawnOn[] => [
  ...s.sentPreviews.flatMap(({ edit, drag }) => [
    ...(drag?.commandId && !drag.copy ? [{ edit: null, drag, on: drag.commandId }] : []),
    ...(edit?.inputs.flatMap((input, i) => {
      const id = edit.commandIds?.[i];
      return id && s.sent.has(id)
        ? [{ edit: { inputs: [input], commandIds: [id] }, drag: null, on: id }]
        : [];
    }) ?? []),
  ]),
  ...s.held.map((h) => ({ ...h.preview, on: h.token })),
];

/**
 * The seed of what is drawn on Node `nodeId` as drawn: the `drawnOn` entries that edit it (#293,
 * #308).
 */
export const seedOf = (s: Pick<ViewState, "sentPreviews" | "sent" | "held">, nodeId: string) =>
  drawnOn(s)
    .filter(({ edit }) => edit?.inputs.some((i) => i.nodeId === nodeId))
    .map(({ on }) => on);

/** `doc` as the person sees it under the gesture being made: with what `drawnOn` lists applied. */
export const asDrawn = (doc: Document, s: Pick<ViewState, "sentPreviews" | "sent" | "held">) =>
  previewAll(doc, drawnOn(s));

/** What a settled held edit leaves the store, and the notices it adds. */
type Settled = { state: Partial<ViewState>; notices: Parameters<typeof joinNotices>[0] };

type Drawing = Pick<
  ViewState,
  "doc" | "sentPreviews" | "sent" | "held" | "pen" | "penPress" | "edit"
>;

/**
 * What goes when the edits `gone` names, by command id or held token, are never applied: the held
 * edits drawn on them, and those drawn on these in turn, the Pen's continuation drawn on any, else
 * its connection, each with its tool's `unapplied` notice. Nothing they drew is sent (#293, #308,
 * #309).
 */
export function dropDrawnOn(s: Drawing, gone: string[]): Settled {
  const dead = new Set(gone);
  const on = (e: { seed?: string[] } | undefined) => !!e?.seed?.some((k) => dead.has(k));
  // Held edits run in order, so each is drawn only on those before it.
  const held: Held[] = [];
  const lost: Held[] = [];
  for (const h of s.held) {
    const goes = on(h);
    if (goes) dead.add(h.token);
    (goes ? lost : held).push(h);
  }
  const dropped = lost.length > 0;
  const stopped = on(s.pen?.from);
  const unmet = !stopped && s.pen && on(s.pen.to) ? disconnected(s.pen, s.penPress) : null;
  return {
    state: {
      ...(dropped && { held }),
      ...(stopped && { pen: null, ...(s.edit && { edit: null }) }),
      ...(unmet && {
        ...penState(s.doc && asDrawn(s.doc, { ...s, held }), unmet.pen, s.edit),
        penPress: unmet.penPress,
      }),
    },
    notices: [
      stopped && PEN_STOPPED.unapplied,
      unmet && PEN_DISCONNECTED.unapplied,
      ...lost.map((h) => h.redraw?.dropped.unapplied),
    ],
  };
}

/**
 * After held edit `token` ran and sent `ids`: what was drawn on it waits for their answers instead,
 * or, when it sent nothing, goes (#308).
 */
export function heldRan(s: Drawing, token: string, ids: string[]): Settled {
  if (ids.length === 0) return dropDrawnOn(s, [token]);
  const { pen } = s;
  const named = (e: { seed?: string[] } | undefined) => !!e?.seed?.includes(token);
  if (!s.held.some(named) && !named(pen?.from) && !named(pen?.to))
    return { state: {}, notices: [] };
  const swap = <E extends { seed?: string[] }>(e: E): E =>
    named(e) ? { ...e, seed: e.seed?.flatMap((k) => (k === token ? ids : [k])) } : e;
  return {
    state: {
      held: s.held.map(swap),
      ...(pen && {
        pen: {
          ...pen,
          ...(pen.from && { from: swap(pen.from) }),
          ...(pen.to && { to: swap(pen.to) }),
        },
      }),
    },
    notices: [],
  };
}

/**
 * The Pen's path and its preview: a continued path is drawn as its Node, in its own Fill and
 * Stroke, a Direct Selection preview of its `set_d`, once the Pen has drawn on it; before that,
 * an unsent preview goes.
 */
export function penState(doc: Document | null, pen: PenPath | null, edit: PathDrag | null) {
  const from = pen?.from;
  if (!doc || !pen || !from || pen.anchors.length <= from.kept)
    return { pen, ...(edit && { edit: null }) };
  return {
    pen,
    edit: { inputs: [replaceSubpath(doc, from, pen.anchors, false)], commandIds: null },
  };
}

/**
 * The Pen's path with its connection dropped, as before the press on the Endpoint, and its press,
 * which connects nothing now (#290).
 */
export const disconnected = (pen: PenPath, press: PenPress | null) => ({
  pen: { ...pen, to: undefined, anchors: pen.anchors.slice(0, -1) },
  penPress: press && { ...press, kind: "dropped" as const },
});

/**
 * The Pen's Endpoints on a subpath in `turned`, on the same Anchors, renumbered as a held Pen
 * edit's keys are (ADR-0110).
 */
function turnedPen(doc: Document, pen: PenPath, turned: Reversing["subpaths"]): PenPath {
  const same = <E extends Endpoint>(e: E): E => ({
    ...e,
    ...endOf(reversedKey(doc, turned, false)(endKey(doc, e))),
  });
  return {
    ...pen,
    ...(pen.from && { from: same(pen.from) }),
    ...(pen.to && { to: same(pen.to) }),
  };
}

/** `doc` with a `path_op` applied by core, or as it is when core refuses it. */
export function previewOp(
  doc: Document,
  { input, geometry }: Pick<PathOpPreview, "input" | "geometry">,
): Document {
  const shown = { ...doc, nodes: new Map(doc.nodes) };
  try {
    pathOp(shown, input, geometry);
    return shown;
  } catch (e) {
    console.warn("A path_op preview skipped what core refuses.", e);
    return doc;
  }
}

/** The drag without the paths whose command `id` was answered or rejected; null once none is left. */
function settle(edit: PathDrag | null, id: string | undefined): { edit?: PathDrag | null } {
  const ids = edit?.commandIds;
  if (!edit || !ids || !id || !ids.includes(id)) return {};
  const inputs = edit.inputs.filter((_, i) => ids[i] !== id);
  const commandIds = ids.filter((c) => c !== id);
  return { edit: inputs.length > 0 ? { inputs, commandIds } : null };
}

/**
 * How the person's `command` renumbers paths' Anchors on `doc` (#298): undefined when it keeps the
 * numbering, null when the browser cannot tell, as for Undo, Redo, a `path_op` or a `path_join`, and
 * else how. A `delete` takes its paths' Anchors away, so an edit on them waits and is dropped. Any
 * other value opens the window ADR-0110 holds edits by index for.
 */
export function opening(doc: Document | null, command: Command): Renumbering | null | undefined {
  if (command.type === "path_edit") return renumberingOf(doc, command.input);
  const opens = ["path_join", "path_op", "undo", "redo", "delete"].includes(command.type);
  return opens ? null : undefined;
}

/** The window without command `id`, answered or rejected. */
function settleRenumbering(renumbering: ViewState["renumbering"], id: string | undefined) {
  if (!id || !renumbering.has(id)) return {};
  const left = new Map(renumbering);
  left.delete(id);
  return { renumbering: left };
}

/** A held edit's unsent preview turned and renumbered as its keys are (#286, #298). */
function renumberPreview(
  doc: Document,
  turned: Reversing["subpaths"],
  r: Renumbering | null,
  { preview: p, pulled }: Held,
): Preview {
  if (!p.edit || p.edit.commandIds !== null) return p;
  const inputs = p.edit.inputs
    .map((i) => renumberInput(r, turnInput(doc, turned, i, pulled)))
    .filter((i) => i !== null);
  return { ...p, edit: inputs.length > 0 ? { ...p.edit, inputs } : null };
}

/** A held `set_d` edit's preview: what `Redraw` worked out, or none once it is dropped (#286). */
const redrawn = (r: ReturnType<Redraw>): Preview => ({
  edit: typeof r === "string" ? null : { inputs: [r.input], commandIds: null },
  drag: null,
});

/** The record of commands in flight without command `id`, answered or rejected. */
function settleSent(sent: ReadonlySet<string>, id: string | undefined) {
  if (!id || !sent.has(id)) return {};
  const left = new Set(sent);
  left.delete(id);
  return { sent: left };
}

/**
 * What Direct Selection keys index on Node `id` in `doc` (#288): a path's or Live Shape's Anchors in
 * its own coordinates, and its type; undefined once it is gone.
 */
function geometryOf(doc: Document | null, id: string) {
  const n = doc?.nodes.get(id);
  return n && JSON.stringify([n.type, hasAnchors(n) ? localAnchors(n) : null]);
}

/**
 * The sent previews without what the answer or rejection to command `id` settled: the one step every
 * answer and rejection takes for them, as a reconnect clears them all (#285).
 */
function settleSentPreviews(
  sent: SentPreview[],
  id: string | undefined,
): { sentPreviews?: SentPreview[] } {
  if (!id || !sent.some((p) => p.drag?.commandId === id || p.edit?.commandIds?.includes(id))) {
    return {};
  }
  return {
    sentPreviews: sent.flatMap((p) => {
      const { edit = p.edit } = settle(p.edit, id);
      const drag = p.drag?.commandId === id ? null : p.drag;
      return edit || drag ? [{ ...p, edit, drag }] : [];
    }),
  };
}

/** The pending creates without the one whose command `id` was answered or rejected. */
function settlePending(pending: PendingCreate[], id: string | undefined) {
  const left = pending.filter((p) => p.commandId !== id);
  return left.length < pending.length ? { pending: left } : {};
}

/** `GET /api/docs/:docId` after a socket closed unopened: its status and error code, or null. */
export type Probe = { status: number; code?: string } | null;

/**
 * What a tab does after a socket that never opened, from the probe: a browser cannot read the
 * upgrade's refusal. Only a readable 404 or 401 ends retrying; a network error or 5xx says nothing
 * about access. No Role and a deleted Document read alike (ADR-0047).
 */
export function afterProbe(probe: Probe): "retry" | "sign-in" | { notice: string } {
  if (probe?.status === 401) return "sign-in";
  if (probe?.status === 404 && probe.code === "DOC_NOT_FOUND")
    return { notice: "This Document is no longer available to you." };
  return "retry";
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);
