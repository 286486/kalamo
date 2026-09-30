// The Gradient panel's and Gradient tool's edits (ADR-0081): what they paint, and the stop maths.
import {
  AppearanceInput,
  type ColorStop,
  childrenOf,
  colorAt,
  type Document,
  type Fill,
  type Gradient,
  invert,
  type LeafNode,
  type Matrix,
  MIDPOINT_MAX,
  MIDPOINT_MIN,
  type Node,
  paint,
  type Stroke,
} from "@kalamo/core";
import { editable } from "./selection.ts";
import { send, useStore } from "./store.ts";

/** The Fill or Stroke box: which paint the panel and the tool edit, as in Illustrator. */
export type Box = "fill" | "stroke";

/** One Node's new Fills or Strokes, as the `appearance` command sends them. */
export type PaintUpdate = { nodeId: string; appearance: { fills: Fill[] } | { strokes: Stroke[] } };

/** A drag's or edit's paints, drawn until its command is answered; `commandId` once it is sent. */
export interface PaintPreview {
  updates: PaintUpdate[];
  commandId: string | null;
}

/** Illustrator's default gradient: white to black. */
export const DEFAULT_STOPS: ColorStop[] = [
  { offset: 0, color: "#FFFFFF" },
  { offset: 1, color: "#000000" },
];

/**
 * The leaves the panel and the tool paint: each editable leaf with an Appearance in the Selection,
 * and in its Groups. A Layer's or Group's own Appearance is left alone.
 */
export function paintTargets(doc: Document, selection: string[]): LeafNode[] {
  const walk = (n: Node | undefined): LeafNode[] => {
    if (!n || !n.visible || n.locked || n.type === "image") return [];
    if (n.type === "group" || n.type === "layer") return childrenOf(doc, n.id).flatMap(walk);
    return [n];
  };
  const ids = selection.filter((id) => editable(doc, doc.nodes.get(id)));
  return [...new Set(ids.flatMap((id) => walk(doc.nodes.get(id))))];
}

const listOf = (n: LeafNode, box: Box): (Fill | Stroke)[] =>
  box === "fill" ? n.appearance.fills : n.appearance.strokes;

/** The topmost paint of `box`: the last Fill or Stroke, which Illustrator's panel edits. */
export const activePaint = (n: LeafNode, box: Box) => listOf(n, box).at(-1);

/** The active paint's gradient, or null for a solid paint or none. */
export function activeGradient(n: LeafNode | undefined, box: Box): Gradient | null {
  const p = n && activePaint(n, box);
  return p?.type === "gradient" ? p.gradient : null;
}

/**
 * A gradient on `n` with the geometry it leaves out filled in from its own bounds, as `node_update`
 * writes it (ADR-0026): a linear one may give an input-only `angle`.
 */
export function placeOn(
  n: LeafNode,
  g: { type: Gradient["type"]; stops: ColorStop[] } & Record<string, unknown>,
): Gradient {
  const fills = [{ type: "gradient", gradient: g }];
  const [fill] = paint(AppearanceInput.parse({ fills }), "", n).fills;
  return (fill as Extract<Fill, { type: "gradient" }>).gradient;
}

const LINE = { width: 1, cap: "butt", join: "miter", miterLimit: 10, dash: [] } as const;

/** `n`'s list `box` with its topmost paint made `g`, or `g` added to an empty list. */
function painted(n: LeafNode, box: Box, g: Gradient): PaintUpdate["appearance"] {
  if (box === "fill") {
    const fill: Fill = { type: "gradient", gradient: g };
    return { fills: [...n.appearance.fills.slice(0, -1), fill] };
  }
  const { strokes } = n.appearance;
  const { width, cap, join, miterLimit, dash } = strokes.at(-1) ?? LINE;
  const stroke: Stroke = {
    type: "gradient",
    gradient: g,
    width,
    cap,
    join,
    miterLimit,
    dash: [...dash],
  };
  return { strokes: [...strokes.slice(0, -1), stroke] };
}

/**
 * Each target's active paint made what `next` gives from its gradient (null for a solid paint or
 * none); a target for which `next` gives null is left out.
 */
export function paintUpdates(
  targets: LeafNode[],
  box: Box,
  next: (g: Gradient | null, n: LeafNode) => Gradient | null,
): PaintUpdate[] {
  return targets.flatMap((n) => {
    const g = next(activeGradient(n, box), n);
    return g ? [{ nodeId: n.id, appearance: painted(n, box, g) }] : [];
  });
}

/** `doc` with the preview's paints, as a new Document; `doc` is left untouched. */
export function withPaints(doc: Document, updates: PaintUpdate[]): Document {
  const nodes = new Map(doc.nodes);
  for (const { nodeId, appearance } of updates) {
    const n = nodes.get(nodeId);
    if (n && "appearance" in n && n.type !== "group" && n.type !== "layer") {
      nodes.set(nodeId, { ...n, appearance: { ...n.appearance, ...appearance } } as Node);
    }
  }
  return { ...doc, nodes };
}

/** Draws `updates` until told otherwise: a drag's frame. */
export const previewPaint = (updates: PaintUpdate[]) =>
  useStore.setState({ paintPreview: { updates, commandId: null } });

/** Drops a drag's preview: Escape, or a release that changed nothing. */
export const cancelPaint = () => useStore.setState({ paintPreview: null });

/** Sends `updates` as one `appearance` command, one Transaction, drawn until its answer. */
export function sendPaint(updates: PaintUpdate[]) {
  if (updates.length === 0) return cancelPaint();
  const commandId = send({ type: "appearance", updates });
  useStore.setState({ paintPreview: { updates, commandId }, notice: null });
}

// The stops, as the panel's slider and the Annotator's bar edit them. Each returns stops the schema
// accepts: sorted by offset, midpoints 13%–87%, none on the last stop, 0.5 left out.

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** Offsets at 1e-6, so arithmetic leaves no 1e-17 behind. */
const tidy = (t: number) => Math.round(t * 1e6) / 1e6;

/** A midpoint as stored: 13%–87%, and none at halfway. */
function withMidpoint(s: ColorStop, m: number | undefined): ColorStop {
  const { midpoint: _, ...rest } = s;
  if (m === undefined) return rest;
  const kept = tidy(Math.min(MIDPOINT_MAX, Math.max(MIDPOINT_MIN, m)));
  return kept === 0.5 ? rest : { ...rest, midpoint: kept };
}

/** Sorted stably by offset, the last stop without a midpoint; `moved` follows its stop. */
function canonical(stops: ColorStop[], moved = -1): { stops: ColorStop[]; index: number } {
  const order = stops.map((s, i) => ({ s, i })).sort((a, b) => a.s.offset - b.s.offset);
  const sorted = order.map(({ s }, k) => (k === order.length - 1 ? withMidpoint(s, undefined) : s));
  return { stops: sorted, index: order.findIndex(({ i }) => i === moved) };
}

/** A stop added at `t` in the colour the gradient has there; its span's midpoint goes back to 50%. */
export function addStop(stops: ColorStop[], t: number): { stops: ColorStop[]; index: number } {
  const offset = tidy(clamp01(t));
  const before = stops.findLastIndex((s) => s.offset <= offset);
  const added = { offset, color: colorAt(stops, offset) };
  const kept = stops.map((s, i) => (i === before ? withMidpoint(s, undefined) : s));
  return canonical([...kept, added], stops.length);
}

/** Stop `i` moved to `t`, keeping its colour and midpoint; `index` is where it sorts to. */
export function moveStop(stops: ColorStop[], i: number, t: number) {
  const moved = stops.map((s, k) => (k === i ? { ...s, offset: tidy(clamp01(t)) } : s));
  return canonical(moved, i);
}

/** Stop `i` removed; null while only two remain, as Illustrator refuses. */
export function removeStop(stops: ColorStop[], i: number): ColorStop[] | null {
  if (stops.length <= 2) return null;
  return canonical(stops.filter((_, k) => k !== i)).stops;
}

/** Stop `i`'s midpoint, towards the next stop, set to `m` within 13%–87%. */
export const setMidpoint = (stops: ColorStop[], i: number, m: number): ColorStop[] =>
  i < stops.length - 1 ? stops.map((s, k) => (k === i ? withMidpoint(s, m) : s)) : stops;

/** Stop `i`'s colour; its alpha is its opacity. */
export const setColor = (stops: ColorStop[], i: number, color: string): ColorStop[] =>
  stops.map((s, k) => (k === i ? { ...s, color } : s));

/**
 * Illustrator's Reverse: each offset becomes 1 − offset, and each midpoint moves to the mirrored
 * span as 1 − m, on the stop that now starts it.
 */
export function reverseStops(stops: ColorStop[]): ColorStop[] {
  const n = stops.length;
  return stops.toReversed().map((s, k) => {
    // The stop at k was at n − 1 − k; the span it now starts was the one ending at it.
    const m = stops[n - 2 - k]?.midpoint;
    return withMidpoint({ ...s, offset: tidy(1 - s.offset) }, m === undefined ? undefined : 1 - m);
  });
}

/** Degrees to radians. */
export const RAD = Math.PI / 180;

/** The page's angle, degrees clockwise from 3 o'clock, of the direction (dx, dy) in the leaf's own coordinates. */
const pageAngle = ([a, b, c, d]: Matrix, dx: number, dy: number) =>
  Math.atan2(b * dx + d * dy, a * dx + c * dy) / RAD;

/** The unit direction in the leaf's own coordinates that the page shows at `degrees`. */
function ownDirection(m: Matrix, degrees: number): [number, number] {
  const [a, b, c, d] = invert(m);
  const [cos, sin] = [Math.cos(degrees * RAD), Math.sin(degrees * RAD)];
  const [x, y] = [a * cos + c * sin, b * cos + d * sin];
  const len = Math.hypot(x, y);
  return [x / len, y / len];
}

/** The panel's Angle, as the page shows it through the leaf's world transform `m`. */
export const angleOf = (g: Gradient, m: Matrix) =>
  g.type === "linear"
    ? pageAngle(m, g.end.x - g.start.x, g.end.y - g.start.y)
    : pageAngle(m, Math.cos(g.angle * RAD), Math.sin(g.angle * RAD));

/** The own-coordinate angle that shows as `degrees` on the page, for a linear gradient's input `angle`. */
export const ownAngle = (m: Matrix, degrees: number) => {
  const [x, y] = ownDirection(m, degrees);
  return Math.round((Math.atan2(y, x) / RAD) * 1e3) / 1e3;
};

/**
 * The panel's Angle set to `degrees` on the page: a linear vector turned about `start`, its length
 * kept; a radial gradient's `angle`.
 */
export function withAngle(g: Gradient, degrees: number, m: Matrix): Gradient {
  if (g.type === "radial") return { ...g, angle: ownAngle(m, degrees) };
  const length = Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y);
  const [ux, uy] = ownDirection(m, degrees);
  const at = (v: number) => Math.round(v * 1e3) / 1e3 || 0;
  return { ...g, end: { x: at(g.start.x + length * ux), y: at(g.start.y + length * uy) } };
}
