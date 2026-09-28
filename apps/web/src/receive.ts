import {
  type BareAnchor,
  type Document,
  editPath,
  type Geometry,
  type PathEditInput,
  type PathOpInput,
  pathOp,
  transformNodes,
} from "@zibel/core";
import { applyBroadcast, type ServerMessage } from "@zibel/sync";
import type { CurveAnchor } from "./curvature.ts";
import { inRange, parseKey, segmentInRange } from "./direct.ts";
import { prune } from "./isolation.ts";

/** The Selection being dragged by (dx, dy) pt. `commandId` is set once its move has been sent. */
export interface Drag {
  nodeIds: string[];
  dx: number;
  dy: number;
  commandId: string | null;
}

/** An open subpath's Endpoint: its first Anchor, or its last. */
export interface Endpoint {
  nodeId: string;
  subpath: number;
  atStart: boolean;
}

/** A Rectangle or Ellipse dragged out, in document coordinates. */
export interface ShapeBox {
  type: "rect" | "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The path the Pen is drawing, in document coordinates (ADR-0032). It stays in the browser until
 * finished; `commandId` is set once its `create` has been sent, and it is drawn until the answer.
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
  commandId: string | null;
  /** A Rectangle or Ellipse tool's Live Shape, sent on release; `anchors` is empty. */
  shape?: ShapeBox;
  /** A Pencil stroke, sent on release: the Fill it is drawn with, and whether it stays selected. */
  pencil?: { fill: string | null; keep: boolean };
  /** A `create` from an isolated leaf `from`: the level `to` go up to once its `tx` creates the path. */
  leave?: { from: string; to: string | null };
}

/**
 * A Direct Selection drag: one `path_edit` per path. `commandIds`, one per input, is set once they
 * are sent; each answer or rejection takes its path out, and the preview lasts until the last one.
 */
export interface PathDrag {
  inputs: PathEditInput[];
  commandIds: string[] | null;
}

/**
 * Object > Path > Simplify or Offset Path while its bar or dialog is open: previewed in the
 * browser, then sent as one `path_op` on OK (ADR-0035); `commandId` is set then, and it is drawn
 * until the answer.
 */
export interface PathOpPreview {
  input: PathOpInput;
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
  /** Drawn until the answer to its command arrives, so a committed move does not flicker. */
  drag: Drag | null;
  pen: PenPath | null;
  edit: PathDrag | null;
  opPreview: PathOpPreview | null;
  /** Direct Selection's selected Anchors (direct.ts's keys): UI state, like the Selection. */
  anchors: string[];
  /** Its selected segments, keyed by the Anchor each starts at (ADR-0045). */
  segments: string[];
  /** Why the last command was rejected. */
  notice: string | null;
}

/**
 * The ViewState after one server message (ADR-0009, ADR-0010), or null when a `rev` was missed and
 * the browser must reconnect for the whole Document.
 */
export function receive(
  s: ViewState,
  msg: ServerMessage,
  docId: string,
): Partial<ViewState> | null {
  if (msg.type === "rejected") {
    const gone = msg.error.code === "NODE_GONE";
    return {
      ...(s.drag?.commandId === msg.id && { drag: null }),
      ...(s.pen?.commandId === msg.id && { pen: null }),
      ...(s.opPreview?.commandId === msg.id && { opPreview: null }),
      ...settle(s.edit, msg.id),
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
  const drawn = msg.type === "tx" && !!msg.commandId && msg.commandId === s.pen?.commandId;
  // Someone else's change to a path renumbers its Anchors, so its selected ones go; after our own
  // command, and on a reconnect, those it still has stay.
  const ours = [...(s.edit?.commandIds ?? []), s.drag?.commandId];
  const own = msg.type === "tx" && !!msg.commandId && ours.includes(msg.commandId);
  const touched =
    msg.type === "tx" ? new Set([...msg.updated.map((n) => n.id), ...msg.deletedIds]) : null;
  const kept = (inRangeOf: typeof inRange) => (key: string) => {
    const changed = !touched || touched.has(parseKey(key).nodeId);
    return !changed || ((own || !touched) && inRangeOf(doc, key));
  };
  const anchors = s.anchors.filter(kept(inRange));
  const segments = s.segments.filter(kept(segmentInRange));
  const skipped = msg.type === "tx" ? (msg.skippedIds?.length ?? 0) : 0;
  // A selected Node that a browser's command moved into a new Group selects that Group, as Make
  // Clipping Mask does; an Agent's edit leaves the person's Selection alone.
  const made = new Set(msg.type === "tx" && msg.commandId ? msg.created.map((n) => n.id) : []);
  const selection = s.selection.flatMap((id) => {
    const parentId = doc.nodes.get(id)?.parentId;
    if (parentId === undefined) return [];
    return parentId && made.has(parentId) ? [parentId] : [id];
  });
  const isolated = prune(s.doc, doc, s.isolated);
  // The drawn path leaves its leaf, unless an Esc or a prune moved the Isolation meanwhile.
  const leave = drawn ? s.pen?.leave : undefined;
  return {
    doc,
    isolated: leave && isolated === leave.from ? prune(s.doc, doc, leave.to) : isolated,
    // The path the Pen drew becomes the Selection, as in Illustrator.
    selection: drawn ? (s.pen?.pencil?.keep === false ? [] : [...made]) : [...new Set(selection)],
    ...(answered && { drag: null }),
    anchors,
    segments,
    ...(msg.type === "document" ? { edit: null } : settle(s.edit, msg.commandId)),
    ...((drawn || (msg.type === "document" && s.pen?.commandId)) && { pen: null }),
    ...(s.opPreview?.commandId &&
      (msg.type === "document" || msg.commandId === s.opPreview.commandId) && { opPreview: null }),
    ...(skipped > 0 && { notice: `Skipped ${skipped} deleted object(s); they stay deleted.` }),
  };
}

/**
 * `doc` with the drag applied by core, as the Document DO will apply it. Nodes deleted meanwhile
 * are left out here; the command still names them, so it is rejected (ADR-0010).
 */
export function preview(doc: Document, { nodeIds, dx, dy }: Drag): Document {
  const shown = { ...doc, nodes: new Map(doc.nodes) };
  const present = nodeIds.filter((id) => doc.nodes.has(id));
  if (present.length > 0) transformNodes(shown, { nodeIds: present, translate: { x: dx, y: dy } });
  return shown;
}

/**
 * `doc` with a Direct Selection drag applied by core. Its ops are absolute, so one already
 * committed applies again unchanged; one core refuses, such as on a Node deleted meanwhile, is left
 * out here and rejected by the DO.
 */
export function previewEdit(doc: Document, { inputs }: PathDrag): Document {
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

/** The drag without the path whose command `id` was answered or rejected; null once none is left. */
function settle(edit: PathDrag | null, id: string | undefined): { edit?: PathDrag | null } {
  const k = id && edit?.commandIds ? edit.commandIds.indexOf(id) : -1;
  if (!edit?.commandIds || k < 0) return {};
  const inputs = edit.inputs.filter((_, i) => i !== k);
  const commandIds = edit.commandIds.filter((_, i) => i !== k);
  return { edit: inputs.length > 0 ? { inputs, commandIds } : null };
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
