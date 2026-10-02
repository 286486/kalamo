import {
  type Anchor,
  type BareAnchor,
  type Document,
  formatPath,
  fromAnchors,
  type PathEditInput,
  type PathOp,
} from "@kalamo/core";
import {
  anchorKey,
  anchorsOf,
  hasAnchors,
  inRange,
  localAnchors,
  localDelta,
  parseKey,
  plus,
} from "./direct.ts";
import { editable } from "./selection.ts";
import { send, unheld, useStore } from "./store.ts";
import { drawing, finishPen, near } from "./tools.ts";

/** The Curvature tool (research 06 §2): clicks place Anchors and the curve runs through them. */

type Point = [number, number];

/** An Anchor the Curvature tool placed; a Corner has no Handles. */
export interface CurveAnchor {
  at: Point;
  smooth: boolean;
}

/**
 * A Handle's length as a share of its segment's chord: a quarter circle's (4/3 tan 22.5° over
 * √2), so four Anchors on a circle close into it.
 */
const REACH = 0.3905;
/** Two presses this close in time, on the same Anchor, are a double-click. */
const DOUBLE_MS = 500;

/** A Smooth Anchor's Handles: along the chord from `prev` to `next`, each reaching toward its neighbour. */
function curveHandles(prev: Point, [x, y]: Point, next: Point): [Point, Point] | null {
  const [dx, dy] = [next[0] - prev[0], next[1] - prev[1]];
  const l = Math.hypot(dx, dy);
  if (!l) return null;
  const [ux, uy] = [dx / l, dy / l];
  const lin = Math.hypot(x - prev[0], y - prev[1]) * REACH;
  const lout = Math.hypot(next[0] - x, next[1] - y) * REACH;
  return [
    [x - ux * lin, y - uy * lin],
    [x + ux * lout, y + uy * lout],
  ];
}

/** Anchor `i`'s neighbours, round a closed subpath; null for an open one's Endpoints. */
function neighbours<T>(items: T[], i: number, closed: boolean): [T, T] | null {
  const n = items.length;
  if (n < 3 || (!closed && (i === 0 || i === n - 1))) return null;
  return [items[(i + n - 1) % n] as T, items[(i + 1) % n] as T];
}

/**
 * The Anchors of a curve through the Anchors placed: a Smooth Anchor's Handles follow its neighbours, as a
 * Catmull-Rom spline's do, and a Corner and an open curve's Endpoints have none.
 */
export function curveThrough(curve: CurveAnchor[], closed: boolean): BareAnchor[] {
  return curve.map((p, i) => {
    const around = p.smooth ? neighbours(curve, i, closed) : null;
    const h = around && curveHandles(around[0].at, p.at, around[1].at);
    return { anchor: p.at, handleIn: h?.[0] ?? null, handleOut: h?.[1] ?? null };
  });
}

/** Sets the curve of the path being drawn; its Anchors follow it. */
function setCurve(curve: CurveAnchor[]) {
  useStore.setState({
    pen: curve.length > 0 ? { anchors: curveThrough(curve, false), curve, closed: false } : null,
  });
}

/**
 * The press: on an Anchor of the path being drawn (`index`), or on an Anchor of a selected path
 * (`key`), which a drag moves; `from` is where it started. Pressing the first Anchor closes the
 * path on release unless it was dragged.
 */
let press:
  | { kind: "drawn"; index: number; from: Point; close: boolean; moved: boolean }
  | { kind: "anchor"; key: string; from: Point }
  | null = null;
/** The Anchor pressed last, which Delete removes while drawing. */
let current: number | null = null;
let lastDown: { at: Point; time: number } | null = null;

export const curvaturePressed = () => press !== null;

/**
 * A Curvature press at `p` (research 06 §2). While drawing: a double-click on an Anchor toggles it
 * between Smooth and Corner, a press on one grabs it, and elsewhere a click places a Smooth Anchor,
 * or a Corner with Alt. Otherwise a press on an Anchor of a selected path selects and grabs it, a
 * double-click toggles it in one `path_edit`, and elsewhere a new path starts.
 */
export function curvatureDown(p: Point, tolerance: number, alt: boolean) {
  const time = Date.now();
  const double = !!lastDown && time - lastDown.time < DOUBLE_MS && near(p, lastDown.at, tolerance);
  lastDown = double ? null : { at: p, time };
  const s = useStore.getState();
  const pen = drawing(s);
  const curve = pen?.curve ?? [];
  if (pen && curve.length > 0) {
    const index = curve.findIndex((q) => near(p, q.at, tolerance));
    if (index >= 0) {
      current = index;
      const q = curve[index] as CurveAnchor;
      if (double) {
        press = null;
        setCurve(curve.with(index, { ...q, smooth: !q.smooth }));
        return;
      }
      press = {
        kind: "drawn",
        index,
        from: q.at,
        close: index === 0 && curve.length >= 2,
        moved: false,
      };
      return;
    }
  } else if (s.doc) {
    const key = anchorAt(s.doc, s.selection, p, tolerance);
    if (key) {
      press = null;
      if (double) {
        const input = toggleInput(s.doc, key);
        if (input)
          send({ type: "path_edit", input }, unheld("the Curvature tool is not held yet (#276)"));
        return;
      }
      useStore.setState({ anchors: [key] });
      const { index, subpath, nodeId } = parseKey(key);
      const n = s.doc.nodes.get(nodeId);
      const at = hasAnchors(n) && anchorsOf(s.doc, n)[subpath]?.anchors[index]?.anchor;
      if (at) press = { kind: "anchor", key, from: at };
      return;
    }
  }
  current = curve.length;
  press = { kind: "drawn", index: curve.length, from: p, close: false, moved: false };
  setCurve([...curve, { at: p, smooth: !alt }]);
}

/** A drag of the press to `p`: the grabbed Anchor moves and the curve reshapes through it. */
export function curvatureDrag(p: Point) {
  const s = useStore.getState();
  if (press?.kind === "drawn") {
    const curve = drawing(s)?.curve;
    const q = curve?.[press.index];
    if (!curve || !q) return;
    press.moved = true;
    setCurve(curve.with(press.index, { ...q, at: p }));
  } else if (press?.kind === "anchor" && s.doc) {
    const n = s.doc.nodes.get(parseKey(press.key).nodeId);
    if (!n) return;
    const d = localDelta(s.doc, n, p[0] - press.from[0], p[1] - press.from[1]);
    const input = moveInput(s.doc, press.key, d);
    useStore.setState({ edit: input ? { inputs: [input], commandIds: null } : null });
  }
}

/** Releasing: a click on the first Anchor closes the path. */
export function curvatureUp() {
  const closing = press?.kind === "drawn" && press.close && !press.moved;
  press = null;
  if (closing) finishPen(true);
}

export const curvatureCancel = () => {
  press = null;
};

/** Delete while drawing removes the Anchor pressed last; false when not drawing. */
export function removeCurveAnchor(): boolean {
  const curve = drawing(useStore.getState())?.curve;
  if (!curve) return false;
  const i = current !== null && current < curve.length ? current : curve.length - 1;
  setCurve(curve.toSpliced(i, 1));
  current = null;
  return true;
}

/** The key of the selected, editable path's Anchor at `p`, or null. */
function anchorAt(doc: Document, selection: string[], p: Point, tolerance: number) {
  for (const id of selection) {
    const n = doc.nodes.get(id);
    if (!hasAnchors(n) || !editable(doc, n)) continue;
    for (const [k, sub] of anchorsOf(doc, n).entries()) {
      const i = sub.anchors.findIndex((a) => near(p, a.anchor, tolerance));
      if (i >= 0) return anchorKey(id, k, i);
    }
  }
  return null;
}

/** Recomputes the Smooth Anchors among `indices` from their neighbours, in place. */
function reshape(anchors: Anchor[], closed: boolean, indices: number[]) {
  for (const i of indices) {
    const a = anchors[i];
    const around = neighbours(anchors, i, closed);
    const h =
      a?.type === "smooth" && around && curveHandles(around[0].anchor, a.anchor, around[1].anchor);
    if (a && h) [a.handleIn, a.handleOut] = h;
  }
}

/** Anchor `i` and its neighbours, round a closed subpath. */
const withNeighbours = (n: number, i: number, closed: boolean) =>
  [i - 1, i, i + 1].map((j) => (closed ? (j + n) % n : j)).filter((j) => j >= 0 && j < n);

/** Moving the Anchor `key` by `d`, in its path's coordinates: its Smooth neighbours follow it. */
export function moveInput(doc: Document, key: string, d: Point): PathEditInput | null {
  const { nodeId, subpath, index } = parseKey(key);
  const n = doc.nodes.get(nodeId);
  const s = hasAnchors(n) ? localAnchors(n)[subpath] : undefined;
  const a = s?.anchors[index];
  if (!s || !a) return null;
  const to = plus(a.anchor, d);
  const by = (h: Point | null) => h && plus(h, d);
  Object.assign(a, { anchor: to, handleIn: by(a.handleIn), handleOut: by(a.handleOut) });
  const indices = withNeighbours(s.anchors.length, index, s.closed);
  reshape(s.anchors, s.closed, indices);
  const ops: PathOp[] = [{ op: "move_anchor", subpath, index, to }];
  for (const i of indices) {
    const { type, handleIn, handleOut } = s.anchors[i] as Anchor;
    if (type === "smooth") ops.push({ op: "set_handles", subpath, index: i, handleIn, handleOut });
  }
  return { nodeId, ops };
}

/**
 * A double-click on the Anchor `key`: a Smooth one becomes a Corner without Handles, and a Corner
 * becomes Smooth through its neighbours. An open path's Endpoint is always a Corner, so null.
 */
export function toggleInput(doc: Document, key: string): PathEditInput | null {
  const { nodeId, subpath, index } = parseKey(key);
  const n = doc.nodes.get(nodeId);
  const s = hasAnchors(n) ? localAnchors(n)[subpath] : undefined;
  const a = s?.anchors[index];
  if (!s || !a) return null;
  if (a.type === "smooth") {
    return { nodeId, ops: [{ op: "set_point_type", subpath, index, type: "corner" }] };
  }
  const sides = neighbours(s.anchors, index, s.closed);
  const h = sides && curveHandles(sides[0].anchor, a.anchor, sides[1].anchor);
  if (!h) return null;
  return {
    nodeId,
    ops: [{ op: "set_handles", subpath, index, handleIn: h[0], handleOut: h[1] }],
  };
}

/**
 * Edit > Clear under the Curvature tool: removes the selected Anchors and keeps each curve
 * connected, reshaping the Smooth Anchors beside them (research 06 §2). A subpath left with one
 * Anchor goes, and a path left with none is deleted, as are selected objects with no selected
 * Anchor, as clearInputs does.
 */
export function curvatureClearInputs(doc: Document, selection: string[], keys: string[]) {
  const edits: PathEditInput[] = [];
  const ids = new Set(keys.map((k) => parseKey(k).nodeId));
  const deleteIds = selection.filter((id) => !ids.has(id) && editable(doc, doc.nodes.get(id)));
  for (const nodeId of ids) {
    const n = doc.nodes.get(nodeId);
    if (!hasAnchors(n) || !editable(doc, n)) continue;
    const live = keys.filter((k) => parseKey(k).nodeId === nodeId && inRange(doc, k));
    if (live.length === 0) continue;
    const subpaths = localAnchors(n).flatMap((s, k) => {
      const gone = (i: number) => live.includes(anchorKey(nodeId, k, i));
      const kept = s.anchors.filter((_, i) => !gone(i));
      if (kept.length < 2) return [];
      // The Anchors whose neighbours changed: those next to a removed one.
      const m = s.anchors.length;
      const touched = (i: number) =>
        [i - 1, i + 1].some((j) => (s.closed || (j >= 0 && j < m)) && gone((j + m) % m));
      const beside = kept.flatMap((a, j) => (touched(s.anchors.indexOf(a)) ? [j] : []));
      reshape(kept, s.closed, beside);
      if (!s.closed) {
        (kept[0] as Anchor).handleIn = null;
        (kept.at(-1) as Anchor).handleOut = null;
      }
      return [{ ...s, anchors: kept }];
    });
    if (subpaths.length === 0) deleteIds.push(nodeId);
    else edits.push({ nodeId, ops: [{ op: "set_d", d: formatPath(fromAnchors(subpaths)) }] });
  }
  return { edits, deleteIds };
}
