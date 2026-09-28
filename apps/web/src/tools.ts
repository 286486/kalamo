import {
  applyTo,
  type BareAnchor,
  type Document,
  formatPath,
  fromAnchors,
  invert,
  type NodeInput,
  type PathEditInput,
  worldTransform,
} from "@zibel/core";
import { addAnchorAt, deleteAnchorAt } from "./anchorTools.ts";
import { curveThrough } from "./curvature.ts";
import { anchorsOf, editableShapes, hasAnchors, localAnchors } from "./direct.ts";
import { forNewArt } from "./isolation.ts";
import type { Endpoint, PenPath } from "./receive.ts";
import { editable, placeParent } from "./selection.ts";
import { canEdit, DEFAULT_FILL_STROKE, type State, send, useStore, VIEWER_TOOLS } from "./store.ts";
import type { Tool, ToolEvent } from "./toolbox.ts";

/** The Fill and Stroke boxes (F-DRAW-12): what new art is painted with; null is None. */
export interface FillStroke {
  fill: string | null;
  stroke: string | null;
  active: "fill" | "stroke";
}

/** The Fill and Stroke boxes' keys, as in Illustrator, or null for another key. */
export function fillStrokeKey(p: FillStroke, keys: string): FillStroke | null {
  switch (keys) {
    case "D":
      return { ...DEFAULT_FILL_STROKE, active: p.active };
    case "X":
      return { ...p, active: p.active === "fill" ? "stroke" : "fill" };
    case "Shift+X":
      return { ...p, fill: p.stroke, stroke: p.fill };
    case "/":
      return { ...p, [p.active]: null };
    default:
      return null;
  }
}

type Point = [number, number];

/** The path's `d`: its Anchors, curved where they have Handles. */
export const pathD = (anchors: BareAnchor[], closed: boolean) =>
  formatPath(fromAnchors([{ closed, anchors }]));

/** `p` moved onto the nearest line through `from` at a multiple of 45°. */
export function constrain(from: Point, p: Point): Point {
  const [dx, dy] = [p[0] - from[0], p[1] - from[1]];
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
  const length = dx * ux + dy * uy;
  // Rounded, so the diagonal's cos and sin do not leave 1e-15 in `d`.
  const at = (v: number) => Math.round(v * 1e9) / 1e9;
  return [at(from[0] + ux * length), at(from[1] + uy * length)];
}

/**
 * The `create` input for a finished path: the current Fill and Stroke, in placeParent's Layer or
 * isolated Group or sub-Layer; an isolated leaf is left first (`forNewArt`).
 */
export function penNode(
  s: Pick<State, "selection" | "fillStroke" | "isolated"> & { doc: Document },
  pen: PenPath,
): NodeInput | null {
  const { fill, stroke } = s.fillStroke;
  const parentId = placeParent(s.doc, s.selection, s.isolated);
  // Illustrator refuses to draw into a hidden or locked Layer.
  if (!parentId || !editable(s.doc, s.doc.nodes.get(parentId))) return null;
  return {
    type: "path",
    parentId,
    d: pathD(pen.anchors, pen.closed),
    appearance: {
      fills: fill ? [{ color: fill }] : [],
      strokes: stroke ? [{ color: stroke, width: 1 }] : [],
    },
  };
}

/** The path the Pen is drawing, not yet sent. */
export const drawing = (s: State) => (s.pen?.commandId === null ? s.pen : null);

/**
 * Finishes the path the Pen is drawing and sends it as one `create` (ADR-0032). A single Anchor
 * would be a Stray Point, invisible, so it is dropped instead.
 */
export function finishPen(closed = false) {
  const s = useStore.getState();
  const pen = drawing(s);
  if (!pen) return;
  // A curve closing through its first Anchor bends there too.
  const anchors = pen.curve ? curveThrough(pen.curve, closed) : pen.anchors;
  const done = { ...pen, anchors, closed };
  if (s.doc && (pen.from || pen.to)) {
    finishEdit(s.doc, done);
    return;
  }
  const at = s.doc && forNewArt(s.doc, s);
  const node =
    s.doc && at && pen.anchors.length >= 2 ? penNode({ ...s, ...at, doc: s.doc }, done) : null;
  if (!node) {
    useStore.setState({
      pen: null,
      ...(pen.anchors.length >= 2 && {
        notice: "The Layer is hidden or locked; nothing was drawn.",
      }),
    });
    return;
  }
  const commandId = send({ type: "create", nodes: [node] });
  useStore.setState({ ...at, pen: { ...done, commandId } });
}

/** The subpath reversed: its Anchors in the other order, each Handle swapped for the other. */
const flip = (anchors: BareAnchor[]) =>
  anchors
    .map((a): BareAnchor => ({ anchor: a.anchor, handleIn: a.handleOut, handleOut: a.handleIn }))
    .reverse();

/** The Endpoint's subpath in document coordinates, turned to end at it. */
function endingAt(doc: Document, e: Endpoint): BareAnchor[] {
  const n = doc.nodes.get(e.nodeId);
  const s = n && hasAnchors(n) ? anchorsOf(doc, n)[e.subpath] : undefined;
  const anchors = (s?.anchors ?? []).map(({ anchor, handleIn, handleOut }) => ({
    anchor,
    handleIn,
    handleOut,
  }));
  return e.atStart ? flip(anchors) : anchors;
}

/** A `set_d` putting `anchors`, in document coordinates and ending at `e`, in place of its subpath. */
function replaceSubpath(
  doc: Document,
  e: Endpoint,
  anchors: BareAnchor[],
  closed: boolean,
): PathEditInput {
  const n = doc.nodes.get(e.nodeId);
  if (!n || !hasAnchors(n)) throw new Error(`${e.nodeId} has no Anchors.`);
  const m = invert(worldTransform(doc, n));
  const local = (p: Point | null) => p && applyTo(m, p[0], p[1]);
  const all: { closed: boolean; anchors: BareAnchor[] }[] = localAnchors(n);
  // Back in the subpath's own direction.
  all[e.subpath] = {
    closed,
    anchors: (e.atStart ? flip(anchors) : anchors).map((a) => ({
      anchor: applyTo(m, ...a.anchor),
      handleIn: local(a.handleIn),
      handleOut: local(a.handleOut),
    })),
  };
  return { nodeId: e.nodeId, ops: [{ op: "set_d", d: formatPath(fromAnchors(all)) }] };
}

/** Join's distance for the Endpoints a connection put on each other, past `d`'s rounding. */
const COINCIDENT = 0.05;

/**
 * Finishes a path the Pen continued or connected (research 06 §1): one `path_edit` on the path
 * continued, or on the one a new path connected to, which it continues backwards; continuing one
 * onto another is one `path_join`, the Join deleting one of them.
 */
function finishEdit(doc: Document, pen: PenPath) {
  const { from, to, anchors, closed } = pen;
  const last = anchors.at(-1);
  if (!last || (from && !to && !closed && anchors.length <= from.kept)) {
    useStore.setState({ pen: null });
    return;
  }
  let input: PathEditInput;
  let commandId: string;
  if (from) {
    input = replaceSubpath(doc, from, anchors, closed);
    if (to) {
      const theirs = endingAt(doc, to);
      const join = {
        nodeIds: [...new Set([from.nodeId, to.nodeId])],
        op: "join" as const,
        tolerance: COINCIDENT,
        anchors: [
          { ...from, index: from.atStart ? 0 : anchors.length - 1 },
          { ...to, index: to.atStart ? 0 : theirs.length - 1 },
        ].map(({ nodeId, subpath, index }) => ({ nodeId, subpath, index })),
      };
      commandId = send({ type: "path_join", edit: input, join });
    } else commandId = send({ type: "path_edit", input });
  } else if (to) {
    // The new path, from its last Anchor, which is on the Endpoint, continues theirs.
    const theirs = endingAt(doc, to);
    const mine = flip(anchors);
    const end = theirs.at(-1) as BareAnchor;
    const joined = [
      ...theirs.slice(0, -1),
      { ...end, handleOut: mine[0]?.handleOut ?? null },
      ...mine.slice(1),
    ];
    input = replaceSubpath(doc, to, joined, false);
    commandId = send({ type: "path_edit", input });
  } else return;
  const selection = [...new Set([from?.nodeId, to?.nodeId].filter((id) => id !== undefined))];
  useStore.setState({ pen: null, selection, edit: { inputs: [input], commandIds: [commandId] } });
}

/**
 * The Pen's path so far. A continued path is drawn as its Node, in its own Fill and Stroke: a
 * Direct Selection preview of its `set_d`.
 */
function setPen(pen: PenPath | null) {
  const { doc, edit } = useStore.getState();
  const unsent = edit?.commandIds === null ? { edit: null } : {};
  const from = pen?.from;
  if (!doc || !pen || !from || pen.anchors.length <= from.kept) {
    useStore.setState({ pen, ...unsent });
    return;
  }
  const input = replaceSubpath(doc, from, pen.anchors, false);
  useStore.setState({ pen, edit: { inputs: [input], commandIds: null } });
}

/**
 * The Endpoint of a visible, unlocked open path, in the isolated Node `scope` if any, within
 * `tolerance` of `p`, topmost first.
 */
export function endpointAt(
  doc: Document,
  p: Point,
  tolerance: number,
  skip: Endpoint | undefined,
  scope: string | null,
): Endpoint | null {
  for (const n of editableShapes(doc, scope).reverse()) {
    for (const [subpath, s] of anchorsOf(doc, n).entries()) {
      if (s.closed || (skip?.nodeId === n.id && skip.subpath === subpath)) continue;
      const [first] = s.anchors;
      const last = s.anchors.at(-1);
      if (first && near(p, first.anchor, tolerance))
        return { nodeId: n.id, subpath, atStart: true };
      if (last && near(p, last.anchor, tolerance)) return { nodeId: n.id, subpath, atStart: false };
    }
  }
  return null;
}

/** The Pen's modifiers while its button is down. */
export type PenMods = Pick<ToolEvent, "shift" | "alt" | "ctrl" | "space">;

/**
 * The Anchor the Pen's button is down on, at `index`, and the pointer's last position. It is one
 * just placed, the last Anchor pressed again, or the first Anchor, which closes the path on release.
 * `broken` is set once Alt broke the Handles, which stay broken for the rest of the press.
 */
let press: {
  kind: "place" | "last" | "close" | "connect";
  index: number;
  at: Point;
  broken?: boolean;
} | null = null;

export const penPressed = () => press !== null;
export const penClosing = () => press?.kind === "close";

export const near = (a: Point, b: Point, tolerance: number) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;

/**
 * A Pen press (research 06 §1): on the first Anchor it will close the path, on the last it removes
 * that Anchor's outgoing Handle, on an open path's Endpoint it continues that path, or while
 * drawing connects to it on release. Not drawing, on a selected path it removes the Anchor it is on
 * or adds one to the segment, unless Shift is held (Auto Add/Delete). Anywhere else it places a
 * Corner Anchor, which a drag then makes Smooth. Shift constrains the new segment to 45°.
 */
export function penDown(p: Point, tolerance: number, shift = false) {
  const s = useStore.getState();
  const pen = drawing(s);
  const anchors = pen?.anchors ?? [];
  const first = anchors[0];
  const last = anchors.at(-1);
  const end = s.doc && endpointAt(s.doc, p, tolerance, pen?.from, s.isolated);
  if (first && anchors.length >= 2 && near(p, first.anchor, tolerance)) {
    press = { kind: "close", index: 0, at: p };
  } else if (pen && last && near(p, last.anchor, tolerance)) {
    press = { kind: "last", index: anchors.length - 1, at: p };
    setPen({ ...pen, anchors: anchors.with(-1, { ...last, handleOut: null }) });
  } else if (s.doc && end && !pen) {
    // Continuing: its Anchors, turned to end at the Endpoint pressed, are the path so far.
    const theirs = endingAt(s.doc, end);
    const at = theirs.length - 1;
    press = { kind: "last", index: at, at: p };
    const done = theirs.with(at, { ...(theirs[at] as BareAnchor), handleOut: null });
    setPen({
      anchors: done,
      closed: false,
      commandId: null,
      from: { ...end, kept: theirs.length },
    });
  } else if (s.doc && end && pen) {
    const theirs = endingAt(s.doc, end);
    const at = (theirs.at(-1) as BareAnchor).anchor;
    press = { kind: "connect", index: anchors.length, at: p };
    setPen({
      ...pen,
      to: end,
      anchors: [...anchors, { anchor: at, handleIn: null, handleOut: null }],
    });
  } else if (
    s.doc &&
    !pen &&
    !shift &&
    (deleteAnchorAt(s.doc, p, tolerance, s.selection) ||
      addAnchorAt(s.doc, p, tolerance, s.selection))
  ) {
    press = null;
  } else {
    press = { kind: "place", index: anchors.length, at: p };
    const anchor = last && shift ? constrain(last.anchor, p) : p;
    setPen({
      ...(pen ?? { closed: false, commandId: null }),
      anchors: [...anchors, { anchor, handleIn: null, handleOut: null }],
    });
  }
}

/**
 * A drag of the press to `p`. It pulls the outgoing Handle and the incoming one mirrors it: Alt
 * leaves the incoming Handle where it is (a Corner, Illustrator's cusp), Ctrl keeps its length, and Shift constrains
 * the Handle to 45°. Space moves the Anchor with its Handles instead. On the last Anchor only the
 * outgoing Handle moves; closing, Alt leaves the outgoing one and shapes the closing segment.
 */
export function penDrag(p: Point, mods: PenMods) {
  const pen = drawing(useStore.getState());
  const a = press && pen?.anchors[press.index];
  if (!press || !pen || !a) return;
  const [dx, dy] = [p[0] - press.at[0], p[1] - press.at[1]];
  press.at = p;
  // Illustrator's documented order is to release Alt, then the button: the cusp stays.
  press.broken ||= mods.alt;
  const alt = press.broken;
  const [x, y] = a.anchor;
  const out = mods.shift ? constrain(a.anchor, p) : p;
  const [ox, oy] = [out[0] - x, out[1] - y];
  const mirror: Point = [x - ox, y - oy];
  let next: BareAnchor;
  if (mods.space) {
    const by = (h: Point | null): Point | null => h && [h[0] + dx, h[1] + dy];
    next = { anchor: [x + dx, y + dy], handleIn: by(a.handleIn), handleOut: by(a.handleOut) };
  } else if (press.kind === "close" && alt) next = { ...a, handleIn: mirror };
  else if (press.kind === "last" || alt) next = { ...a, handleOut: out };
  else if (mods.ctrl && a.handleIn) {
    const k = Math.hypot(a.handleIn[0] - x, a.handleIn[1] - y) / (Math.hypot(ox, oy) || 1);
    next = { ...a, handleIn: [x - ox * k, y - oy * k], handleOut: out };
  } else next = { ...a, handleIn: mirror, handleOut: out };
  setPen({ ...pen, anchors: pen.anchors.with(press.index, next) });
}

/** Drops the press, leaving what it placed but a connection. */
export const penCancel = () => {
  const pen = drawing(useStore.getState());
  if (press?.kind === "connect" && pen)
    setPen({ ...pen, to: undefined, anchors: pen.anchors.slice(0, -1) });
  press = null;
};

/** Releasing the Pen: a press on the first Anchor closes the path, one on an Endpoint connects. */
export function penUp() {
  const kind = press?.kind;
  press = null;
  if (kind === "close" || kind === "connect") finishPen(kind === "close");
}

/** Ctrl+Z while drawing removes the last Anchor locally; false when not drawing. */
export function undoAnchor(): boolean {
  const pen = drawing(useStore.getState());
  if (!pen) return false;
  const curve = pen.curve?.slice(0, -1);
  const anchors = curve ? curveThrough(curve, false) : pen.anchors.slice(0, -1);
  // A continued path's own Anchors stay: undoing past them leaves it as it was.
  const left = anchors.length > (pen.from ? pen.from.kept - 1 : 0);
  setPen(left ? { ...pen, anchors, curve } : null);
  return true;
}

/** Switching tools finishes the path the Pen is drawing, as in Illustrator, and drops selected Anchors and segments. */
export function setTool(tool: Tool) {
  if (!canEdit(useStore.getState()) && !VIEWER_TOOLS.includes(tool)) return;
  finishPen();
  useStore.setState({ tool, anchors: [], segments: [] });
}
