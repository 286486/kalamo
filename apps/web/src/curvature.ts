import {
  type Anchor,
  type BareAnchor,
  type Document,
  formatPath,
  fromAnchors,
  type PathEditInput,
  type PathOp,
} from "@kalamo/core";
import { sendPreview } from "./canvas.ts";
import {
  type AnchorEdits,
  anchorKey,
  anchorsOf,
  hasAnchors,
  inRange,
  localAnchors,
  localDelta,
  parseKey,
  plus,
  type Renumbering,
  renumbering,
  type Target,
  tagged,
} from "./direct.ts";
import { editable } from "./selection.ts";
import { afterRenumbering, send, useStore } from "./store.ts";
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

type AnchorPress = { kind: "anchor"; nodeId: string; from: Point; d?: Point };

/**
 * The press: on an Anchor of the path being drawn (`index`), or on an Anchor of a selected path
 * (`nodeId`), which the store keeps as its `grab` (ADR-0110) and a drag moves by `d`; `from` is where
 * it started. Pressing the first Anchor closes the path on release unless it was dragged.
 */
let press:
  | { kind: "drawn"; index: number; from: Point; close: boolean; moved: boolean }
  | AnchorPress
  | null = null;

/** The key of the selected path's Anchor the press grabbed, as the answer left it. */
const grabbedKey = () => {
  const [t] = useStore.getState().grab?.targets ?? [];
  return t?.kind === "anchor" ? t.key : null;
};

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
  // A clock set back since the last press reads as a new press, never a double-click.
  const since = lastDown ? time - lastDown.time : -1;
  const double = since >= 0 && since < DOUBLE_MS && !!lastDown && near(p, lastDown.at, tolerance);
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
        // Sent once the person's own command that may renumber a path's Anchors (a Reverse Path
        // Direction press is one) is answered, on the Anchor chosen.
        afterRenumbering(
          ({ doc: now, anchors: [held] }, w) => {
            const input = now && held && toggleInput(now, held);
            if (input) send({ type: "path_edit", input }, w);
          },
          { anchors: [key], segments: [] },
        );
        return;
      }
      useStore.setState({ anchors: [key] });
      const { index, subpath, nodeId } = parseKey(key);
      const n = s.doc.nodes.get(nodeId);
      const at = hasAnchors(n) && anchorsOf(s.doc, n)[subpath]?.anchors[index]?.anchor;
      if (!at) return;
      const held: AnchorPress = { kind: "anchor", nodeId, from: at };
      press = held;
      useStore.setState({
        grab: {
          targets: [{ kind: "anchor", key }],
          redraw: (doc, [t]) => (held.d ? movePreview(doc, t, held.d) : null),
        },
      });
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
    const n = s.doc.nodes.get(press.nodeId);
    const key = grabbedKey();
    if (!n || !key) return;
    const d = localDelta(s.doc, n, p[0] - press.from[0], p[1] - press.from[1]);
    press.d = d;
    useStore.setState(movePreview(s.doc, { kind: "anchor", key }, d));
  }
}

/** The preview of moving the grabbed Anchor `t`, when given, by `d` in its path's coordinates. */
function movePreview(doc: Document, t: Target | undefined, d: Point) {
  const input = t?.kind === "anchor" && moveInput(doc, t.key, d);
  return { edit: input ? { inputs: [input] } : null };
}

/**
 * Releasing: a click on the first Anchor closes the path, and a drag of a selected path's Anchor is
 * sent once the person's own command that may renumber a path's Anchors (a Reverse Path Direction
 * press is one) is answered, on the Anchor chosen, from the Document then (ADR-0110); another
 * Actor's edit to the path meanwhile drops it (ADR-0109).
 */
export function curvatureUp() {
  const p = press;
  press = null;
  const key = grabbedKey();
  useStore.setState({ grab: null });
  if (p?.kind === "drawn" && p.close && !p.moved) finishPen(true);
  if (p?.kind !== "anchor" || !p.d || !key) return;
  const d = p.d;
  afterRenumbering(
    ({ doc: now, target }, w) => {
      const input = now && target?.kind === "anchor" && moveInput(now, target.key, d);
      if (input) sendPreview({ edit: { inputs: [input] } }, w);
    },
    { target: { kind: "anchor", key }, previewed: true },
  );
}

export const curvatureCancel = () => {
  press = null;
  useStore.setState({ grab: null });
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
export function curvatureClearInputs(
  doc: Document,
  selection: string[],
  keys: string[],
): Required<AnchorEdits> {
  const edits: PathEditInput[] = [];
  const known: Renumbering[] = [];
  const ids = new Set(keys.map((k) => parseKey(k).nodeId));
  const deleteIds = selection.filter((id) => !ids.has(id) && editable(doc, doc.nodes.get(id)));
  for (const nodeId of ids) {
    const n = doc.nodes.get(nodeId);
    if (!hasAnchors(n) || !editable(doc, n)) continue;
    const live = keys.filter((k) => parseKey(k).nodeId === nodeId && inRange(doc, k));
    if (live.length === 0) continue;
    const subpaths = tagged(n).flatMap((s, k) => {
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
    else {
      edits.push({ nodeId, ops: [{ op: "set_d", d: formatPath(fromAnchors(subpaths)) }] });
      known.push(renumbering(n, subpaths));
    }
  }
  return { edits, deleteIds, known };
}
