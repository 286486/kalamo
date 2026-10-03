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
  turnTarget,
} from "./direct.ts";
import type { PaintPreview } from "./gradient.ts";
import { prune } from "./isolation.ts";
import { type Areas, areasAfter, type Peers, peersAfter } from "./presence.ts";
import { editable, objects } from "./selection.ts";
import type { NodeOp } from "./store.ts";
import type { Tool } from "./toolbox.ts";

/**
 * The Selection being dragged by (dx, dy) pt. `commandId` is set once its move has been sent. With
 * `copy`, Alt held, it leaves the originals and drops copies (ADR-0076); `leave` is the Isolation
 * move its answer makes, as a PendingCreate's.
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
   * The path the Pen continues from its Endpoint: `anchors` start with its subpath's `kept` Anchors,
   * turned to end at that Endpoint. `to` is another path's Endpoint the last Anchor connects to.
   */
  from?: Endpoint & { kept: number };
  to?: Endpoint;
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
 * are sent; each answer or rejection takes its paths out, and the preview lasts until the last one.
 * One command may answer several inputs, as the Attributes panel's `path_reverse` does.
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
};

/** One edit's preview: the paths it reshapes and the Nodes it moves whole. */
export type Preview = Pick<ViewState, "edit" | "drag">;

/**
 * A sent preview in `ran`. `fromHeld` marks a held edit that ran: its keys were worked out for it, not
 * for a drag started later, so its answer does not keep what that drag holds (ADR-0110).
 */
export type Ran = Preview & { fromHeld?: true };

/**
 * A Direct Selection edit made while a Reverse Path Direction press was in flight, run once it is
 * answered (ADR-0110). Its keys are renumbered and cleared as the Direct Selection's are meanwhile.
 * `preview` is its own, drawn until it runs: running or dropping it changes no other preview.
 * `run` is handed the gesture's preview it sets aside meanwhile.
 */
export interface Held {
  chosen: Chosen;
  run: (chosen: Chosen, aside: Preview) => void;
  preview: Preview;
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
  /** Drawn until the answer to its command arrives, so a committed move does not flicker. */
  drag: Drag | null;
  pen: PenPath | null;
  penPress: PenPress | null;
  /** Drawn art sent and not yet answered, oldest first. */
  pending: PendingCreate[];
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
   * Sent previews off the live slots, each drawn until its answer: held edits that ran, and a sent
   * drag whose preview the next drag replaced.
   */
  ran: Ran[];
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
    const gone = msg.error.code === "NODE_GONE";
    return {
      ...settleSent(s.sent, msg.id),
      ...(s.reversing?.commandId === msg.id && { reversing: null }),
      ...settleRenumbering(s.renumbering, msg.id),
      ...(s.drag?.commandId === msg.id && { drag: null }),
      ...settlePending(s.pending, msg.id),
      ...(s.opPreview?.commandId === msg.id && { opPreview: null }),
      ...(s.paintPreview?.commandId === msg.id && { paintPreview: null }),
      ...settle(s.edit, msg.id),
      ...settleRan(s.ran, msg.id),
      notice: gone
        ? "Someone else deleted that object first; it stays deleted."
        : msg.error.message,
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
  // A reconnect loses the answer to a command in flight, so its preview goes with it.
  const answered =
    msg.type === "document" || (!!msg.commandId && msg.commandId === s.drag?.commandId);
  const drawn =
    msg.type === "tx" ? s.pending.find((p) => p.commandId === msg.commandId) : undefined;
  // Someone else's change to a path renumbers its Anchors, so its selected ones go; after the
  // command the keys were worked out for, those it still has stay, and a reconnect reads geometry,
  // as `reshaped` below says. After the person's other commands, they stay on a Node whose geometry
  // it left as it was (#288).
  const id = msg.type === "tx" ? msg.commandId : undefined;
  const pressed = !!id && id === s.reversing?.commandId;
  /** Whether the `tx` answers one of `previews`' commands, or the press. */
  const answers = (previews: Preview[]) =>
    pressed ||
    (!!id && previews.some((p) => p.drag?.commandId === id || !!p.edit?.commandIds?.includes(id)));
  const own = answers([s, ...s.ran]);
  const tracked = own || (!!id && s.sent.has(id));
  // A drag still being made was worked out on the path as it found it at the press: only its own
  // earlier drags and the press keep it on a reshaped path, not a held edit that ran (ADR-0110).
  const grabOwn = answers([s, ...s.ran.filter((p) => !p.fromHeld)]);
  const touched =
    msg.type === "tx" ? new Set([...msg.updated.map((n) => n.id), ...msg.deletedIds]) : null;
  const prior = s.doc;
  // The answer to the person's own command the browser can number renumbers the keys on its path,
  // so each still names its point; one worked out on another numbering, which someone else's edit
  // left, cannot (#298).
  const numbered = id ? s.renumbering.get(id) : undefined;
  const map = numbered && fits(prior, numbered) ? numbered : null;
  const reshapedBy = new Set(
    tracked && touched
      ? [...touched].filter((n) => geometryOf(prior, n) !== geometryOf(doc, n))
      : [],
  );
  // Whether the `tx` leaves keys on Node `n` that are still in range: those worked out for its
  // command (`forIt`) stay; after the person's other commands, only on a Node it did not reshape.
  const keeps = (n: string, forIt: boolean) => forIt || (tracked && !reshapedBy.has(n));
  // The press's answer, or the Document sent on reconnect, settles it: keys on a subpath it turned
  // are renumbered to stay on their points (ADR-0110).
  const settled =
    !!s.reversing && (msg.type === "document" || msg.commandId === s.reversing.commandId);
  // The Document sent on reconnect says nothing of who changed what, so a Node changed while the
  // socket was down when its geometry is neither as it was nor as the press leaves it; a change
  // to its Appearance alone is none, since no key, drag or Pen names that (#287).
  const pressedDoc =
    msg.type === "document" && prior && s.reversing ? previewEdit(prior, s.reversing) : prior;
  const reshaped = (n: string) =>
    msg.type === "document" &&
    geometryOf(prior, n) !== geometryOf(doc, n) &&
    geometryOf(pressedDoc, n) !== geometryOf(doc, n);
  // Its keys go, as for another Actor's edit (ADR-0109): on a path the press names (#276), and on
  // any path with another renumbering command unanswered, which may or may not have been applied
  // (#298). A held edit acts without the person seeing the path again, so its keys go on any path
  // that changed; the live ones the person sees first stay elsewhere while in range (#287).
  const pressNamed = new Set(s.reversing?.subpaths.map((t) => t.nodeId));
  const cleared = (n: string) => reshaped(n) && (pressNamed.has(n) || s.renumbering.size > 0);
  const keptBy = (gone: (n: string) => boolean) => (inRangeOf: typeof inRange) => (key: string) => {
    const { nodeId } = parseKey(key);
    const changed = !touched || touched.has(nodeId);
    return (
      !gone(nodeId) &&
      (!changed ||
        ((!touched || keeps(nodeId, own) || map?.nodeId === nodeId) && inRangeOf(doc, key)))
    );
  };
  const kept = keptBy(cleared);
  const heldKept = keptBy(reshaped);
  const turned =
    settled && prior && s.reversing
      ? turnedOf(
          prior,
          doc,
          s.reversing.subpaths.filter((t) => !cleared(t.nodeId)),
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
  // A held edit's target is turned as its keys are; once a key goes, so does the target.
  const rechosen = ({ target, ...c }: Chosen): Chosen => {
    if (!target) return { ...c, ...rekey(c, heldKept) };
    const t = renumberTarget(map)(turnTarget(doc, turned)(target));
    const k = t && targetKeys(t);
    const on = k?.anchors.every(heldKept(inRange)) && k.segments.every(heldKept(segmentInRange));
    return t && on ? { ...c, ...k, target: t } : { ...c, anchors: [], segments: [] };
  };
  // Someone else's change to the path the Pen continues ends the continuation and its preview, so
  // its finish never writes the Anchors it started from over theirs (ADR-0110). A change to the
  // path a press connects to drops only the connection, so the release joins nothing renumbered
  // or deleted (#290). The person's own command that reshapes the path does too, but the edit the
  // keys were worked out for keeps a connection, which names only an Endpoint; a continuation took
  // its Anchors from the committed Document, before every command unanswered but the press (#288).
  // On a reconnect, a change to its geometry does, as for a held edit's keys (#287); a continuation
  // holds its Anchors where the Document showed them, so a move of its path ends it too.
  const changedBut = (forIt: boolean) => (n: string | undefined) =>
    !!n && (touched ? touched.has(n) && !keeps(n, forIt) : reshaped(n));
  const from = s.pen?.from?.nodeId;
  const placed = (n: string) =>
    String(prior?.nodes.get(n)?.transform) !== String(doc.nodes.get(n)?.transform);
  const reached = changedBut(pressed)(from) || (!touched && !!from && placed(from));
  const pen = s.pen && turned.length > 0 ? turnedPen(doc, s.pen, turned) : s.pen;
  const dropped =
    !reached && pen?.to && changedBut(own)(pen.to.nodeId) ? disconnected(pen, s.penPress) : null;
  // What a drag still being made holds on a path someone else changed goes, read as for the Pen's
  // continuation, and its unsent preview with it; the rest is turned as the keys are (ADR-0110).
  // The answer to a command the browser can number renumbers it instead, and its unsent preview with
  // it, and lets go of what the command removed (#298).
  const letGo = new Set(
    [...new Set(s.grabbed.map(targetNode))].filter(
      (n) => changedBut(grabOwn)(n) && map?.nodeId !== n,
    ),
  );
  const grabbed = s.grabbed
    .filter((t) => !letGo.has(targetNode(t)))
    .map(turnTarget(doc, turned))
    .map(renumberTarget(map))
    .filter(present);
  const keptInputs =
    s.edit?.inputs
      .filter((i) => !letGo.has(i.nodeId))
      .map((i) => renumberInput(map, i))
      .filter(present) ?? [];
  const keptIds = s.drag?.nodeIds.filter((id) => !letGo.has(id)) ?? [];
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
  const copied = msg.type === "tx" && answered && s.drag?.copy ? s.drag : undefined;
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
  return {
    doc,
    isolated: leave && isolated === leave.from ? prune(s.doc, doc, leave.to) : isolated,
    // An unchanged Selection stays the same array, so the Layer rows stay (ADR-0076).
    selection: !tops && sameIds(next, s.selection) ? s.selection : next,
    ...(tops && { layerRows: layers }),
    ...((letGo.size > 0 || !!map) && {
      ...(s.edit?.commandIds === null && {
        edit: keptInputs.length > 0 ? { ...s.edit, inputs: keptInputs } : null,
      }),
      ...(s.drag?.commandId === null && {
        drag: keptIds.length > 0 ? { ...s.drag, nodeIds: keptIds } : null,
      }),
    }),
    ...(answered && { drag: null }),
    ...(msg.type === "document" ? s.sent.size > 0 && { sent: new Set() } : settleSent(s.sent, id)),
    anchors,
    segments,
    ...(msg.type === "document" ? { edit: null } : settle(s.edit, msg.commandId)),
    ...(msg.type === "document"
      ? s.ran.length > 0 && { ran: [] }
      : settleRan(s.ran, msg.commandId)),
    ...(settled && { reversing: null }),
    ...(pen !== s.pen && { pen }),
    ...(dropped && { ...penState(doc, dropped.pen, s.edit), penPress: dropped.penPress }),
    ...((turned.length > 0 || letGo.size > 0 || !!map) && { grabbed }),
    ...(msg.type === "document"
      ? s.renumbering.size > 0 && { renumbering: new Map() }
      : settleRenumbering(s.renumbering, id)),
    ...(s.held.length > 0 && {
      held: s.held.map((h) => ({
        ...h,
        ...(map && { preview: renumberPreview(map, h.preview) }),
        chosen: {
          ...rechosen(h.chosen),
          selection: h.chosen.selection.filter((id) => doc.nodes.has(id)),
        },
      })),
    }),
    ...(msg.type === "document"
      ? s.pending.length > 0 && { pending: [] }
      : settlePending(s.pending, msg.commandId)),
    ...(s.opPreview?.commandId &&
      (msg.type === "document" || msg.commandId === s.opPreview.commandId) && { opPreview: null }),
    ...(s.paintPreview &&
      (msg.type === "document" || msg.commandId === s.paintPreview.commandId) && {
        paintPreview: null,
      }),
    ...(reached && { pen: null, ...(s.edit?.commandIds === null && { edit: null }) }),
    ...((reached || dropped || skipped > 0) && {
      notice: joinNotices([
        reached &&
          "Someone else changed the path the Pen was continuing; the Pen stopped, and what it drew was not applied.",
        dropped &&
          "Someone else changed the path the Pen was connecting to; the connection was not made.",
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
 * Every edit's preview, in the order the Document DO applies them: held edits sent, held edits
 * waiting, then the last gesture's (ADR-0110).
 */
export const previewsOf = (s: Pick<ViewState, "ran" | "held" | "edit" | "drag">): Preview[] => [
  ...s.ran,
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
 * The Pen's path and its preview: a continued path is drawn as its Node, in its own Fill and
 * Stroke, a Direct Selection preview of its `set_d`, once the Pen has drawn on it; before that,
 * an unsent preview goes.
 */
export function penState(doc: Document | null, pen: PenPath | null, edit: PathDrag | null) {
  const from = pen?.from;
  if (!doc || !pen || !from || pen.anchors.length <= from.kept)
    return { pen, ...(edit?.commandIds === null && { edit: null }) };
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

/** A held edit's unsent preview renumbered as its keys are (#298). */
function renumberPreview(r: Renumbering, p: Preview): Preview {
  if (!p.edit || p.edit.commandIds !== null) return p;
  const inputs = p.edit.inputs.map((i) => renumberInput(r, i)).filter((i) => i !== null);
  return { ...p, edit: inputs.length > 0 ? { ...p.edit, inputs } : null };
}

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

/** The held edits' previews without what the answer or rejection to command `id` settled. */
function settleRan(ran: Ran[], id: string | undefined): { ran?: Ran[] } {
  if (!id || !ran.some((p) => p.drag?.commandId === id || p.edit?.commandIds?.includes(id))) {
    return {};
  }
  return {
    ran: ran.flatMap((p) => {
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
