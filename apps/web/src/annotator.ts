// The Gradient Annotator's geometry (ADR-0081): where its parts are drawn, which one a pointer is
// on, and what dragging each does to the gradient. Pointers are in document coordinates; the
// gradient is in the leaf's own, which its world transform maps into them (ADR-0026).
import { applyTo, type Gradient, invert, type Matrix, round3 } from "@kalamo/core";
import { moveStop, RAD, removeStop, setMidpoint } from "./gradient.ts";

export type Point = { x: number; y: number };

/** A part of the Annotator a press can take. */
export type Handle =
  | { kind: "origin" }
  | { kind: "end" }
  | { kind: "aspect" }
  | { kind: "focus" }
  | { kind: "stop"; index: number }
  | { kind: "midpoint"; index: number }
  | { kind: "bar"; t: number };

/** Screen px: how near a handle a press must be, and how far below and above the bar stops and midpoints sit. */
export const HIT = 6;
export const STOP_GAP = 12;
export const MIDPOINT_GAP = 9;
/** Screen px beyond a stop's row, on the Annotator or the panel's slider, past which a dragged stop is removed while more than two remain. */
export const TEAR_OFF = 24;

/** The Annotator's parts, in document coordinates. */
export interface Layout {
  /** The bar: from the first stop's place to the last's. */
  origin: Point;
  end: Point;
  /** Each Color Stop's handle, below the bar. */
  stops: Point[];
  /** Each midpoint's diamond, above the bar, between its stop and the next; null after the last. */
  midpoints: (Point | null)[];
  /** Radial only: the ellipse, dotted, its aspect ratio handle on it, and the focus. */
  ellipse?: Point[];
  aspect?: Point;
  focus?: Point;
}

const at = (m: Matrix, p: Point): Point => {
  const [x, y] = applyTo(m, p.x, p.y);
  return { x, y };
};
const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
/** Rounded to 3 decimals, as export writes positions. */
const roundPoint = (p: Point): Point => ({ x: round3(p.x), y: round3(p.y) });

/** The bar's ends in the leaf's own coordinates. */
function ownBar(g: Gradient): [Point, Point] {
  if (g.type === "linear") return [g.start, g.end];
  const t = g.angle * RAD;
  return [
    g.center,
    { x: g.center.x + g.radius * Math.cos(t), y: g.center.y + g.radius * Math.sin(t) },
  ];
}

/** The unit normal of the bar on screen, below it for a bar drawn left to right. */
function normal(a: Point, b: Point): Point {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
}

/** Where the Annotator of gradient `g`, on a leaf whose world transform is `m`, draws at `scale`. */
export function layout(g: Gradient, m: Matrix, scale: number): Layout {
  const [a, b] = ownBar(g).map((p) => at(m, p)) as [Point, Point];
  const n = normal(a, b);
  const off = (p: Point, px: number) => ({
    x: p.x + (n.x * px) / scale,
    y: p.y + (n.y * px) / scale,
  });
  const stops = g.stops.map((s) => off(lerp(a, b, s.offset), STOP_GAP));
  const midpoints = g.stops.map((s, i) => {
    const next = g.stops[i + 1];
    if (!next) return null;
    const t = s.offset + (s.midpoint ?? 0.5) * (next.offset - s.offset);
    return off(lerp(a, b, t), -MIDPOINT_GAP);
  });
  if (g.type === "linear") return { origin: a, end: b, stops, midpoints };
  const t = g.angle * RAD;
  const [cos, sin] = [Math.cos(t), Math.sin(t)];
  const across = g.radius * g.aspectRatio;
  const ellipse = Array.from({ length: 65 }, (_, k) => {
    const th = (k / 64) * 2 * Math.PI;
    const [u, v] = [g.radius * Math.cos(th), across * Math.sin(th)];
    return at(m, { x: g.center.x + u * cos - v * sin, y: g.center.y + u * sin + v * cos });
  });
  const aspect = at(m, { x: g.center.x - across * sin, y: g.center.y + across * cos });
  return { origin: a, end: b, stops, midpoints, ellipse, aspect, focus: at(m, g.focus) };
}

/** Where `p` falls along the bar, 0 at its origin and 1 at its end, and its distance off it in screen px. */
export function onBar(l: Pick<Layout, "origin" | "end">, p: Point, scale: number) {
  const [dx, dy] = [l.end.x - l.origin.x, l.end.y - l.origin.y];
  const len2 = dx * dx + dy * dy || 1;
  const t = ((p.x - l.origin.x) * dx + (p.y - l.origin.y) * dy) / len2;
  const off =
    (Math.abs((p.x - l.origin.x) * dy - (p.y - l.origin.y) * dx) / Math.sqrt(len2)) * scale;
  return { t, off };
}

/**
 * The part of the Annotator at `p`, or null. A focus on the origin moves with it; Alt takes the
 * focus alone, to pull it off the origin.
 */
export function hitHandle(l: Layout, p: Point, scale: number, alt = false): Handle | null {
  const near = (q: Point | null | undefined) =>
    !!q && Math.hypot(q.x - p.x, q.y - p.y) * scale <= HIT;
  const stop = l.stops.findIndex(near);
  if (stop >= 0) return { kind: "stop", index: stop };
  const midpoint = l.midpoints.findIndex(near);
  if (midpoint >= 0) return { kind: "midpoint", index: midpoint };
  if (near(l.origin) && !(alt && near(l.focus))) return { kind: "origin" };
  if (near(l.focus)) return { kind: "focus" };
  if (near(l.aspect)) return { kind: "aspect" };
  if (near(l.end)) return { kind: "end" };
  const { t, off } = onBar(l, p, scale);
  return off <= HIT && t >= 0 && t <= 1 ? { kind: "bar", t } : null;
}

/** The focus inside the ellipse, as core stores it (ADR-0026). */
function inside(g: Extract<Gradient, { type: "radial" }>, f: Point): Point {
  const t = g.angle * RAD;
  const [dx, dy] = [f.x - g.center.x, f.y - g.center.y];
  const reach = Math.hypot(
    (dx * Math.cos(t) + dy * Math.sin(t)) / g.radius,
    (dy * Math.cos(t) - dx * Math.sin(t)) / (g.radius * g.aspectRatio),
  );
  return reach > 1 ? { x: g.center.x + dx / reach, y: g.center.y + dy / reach } : f;
}

/**
 * `g` with the handle dragged from `from` to `to`, document points, on a leaf whose world
 * transform is `m`. A stop dragged TEAR_OFF px beyond its row is removed while more than two
 * remain; with two, `g` comes back unchanged.
 */
export function dragHandle(
  g: Gradient,
  h: Handle,
  m: Matrix,
  from: Point,
  to: Point,
  scale: number,
): Gradient {
  const own = (p: Point) => at(invert(m), p);
  const [p0, p] = [own(from), own(to)];
  const d = { x: p.x - p0.x, y: p.y - p0.y };
  const plus = (q: Point) => roundPoint({ x: q.x + d.x, y: q.y + d.y });
  const l = layout(g, m, scale);
  switch (h.kind) {
    case "origin":
      return g.type === "linear"
        ? { ...g, start: plus(g.start), end: plus(g.end) }
        : { ...g, center: plus(g.center), focus: plus(g.focus) };
    case "end": {
      if (g.type === "linear") {
        const end = roundPoint(p);
        return end.x === g.start.x && end.y === g.start.y ? g : { ...g, end };
      }
      const radius = round3(Math.hypot(p.x - g.center.x, p.y - g.center.y));
      if (!(radius > 0)) return g;
      const angle = round3(Math.atan2(p.y - g.center.y, p.x - g.center.x) / RAD);
      const turned = { ...g, radius, angle };
      return { ...turned, focus: inside(turned, g.focus) };
    }
    case "aspect": {
      if (g.type !== "radial") return g;
      const t = g.angle * RAD;
      const across = Math.abs(-(p.x - g.center.x) * Math.sin(t) + (p.y - g.center.y) * Math.cos(t));
      const aspectRatio = Math.max(0.01, round3(across / g.radius));
      const flattened = { ...g, aspectRatio };
      return { ...flattened, focus: inside(flattened, g.focus) };
    }
    case "focus":
      return g.type === "radial" ? { ...g, focus: roundPoint(inside(g, p)) } : g;
    case "stop": {
      const { t, off } = onBar(l, to, scale);
      if (off > TEAR_OFF + STOP_GAP) {
        const left = removeStop(g.stops, h.index);
        return left ? { ...g, stops: left } : g;
      }
      return { ...g, stops: moveStop(g.stops, h.index, t).stops };
    }
    case "midpoint": {
      const [s, next] = [g.stops[h.index], g.stops[h.index + 1]];
      if (!s || !next || next.offset === s.offset) return g;
      const { t } = onBar(l, to, scale);
      return {
        ...g,
        stops: setMidpoint(g.stops, h.index, (t - s.offset) / (next.offset - s.offset)),
      };
    }
    case "bar":
      return g;
  }
}

/**
 * The Gradient tool's drag on a leaf: a linear gradient from the press to the release, or a radial
 * one centred at the press reaching the release, its aspect ratio and angle kept. Null when the
 * drag has no length in the leaf's coordinates.
 */
export function dragVector(g: Gradient, m: Matrix, from: Point, to: Point): Gradient | null {
  const [a, b] = [roundPoint(at(invert(m), from)), roundPoint(at(invert(m), to))];
  if (a.x === b.x && a.y === b.y) return null;
  if (g.type === "linear") return { ...g, start: a, end: b };
  const radius = round3(Math.hypot(b.x - a.x, b.y - a.y));
  return radius > 0 ? { ...g, center: a, radius, focus: a } : null;
}
