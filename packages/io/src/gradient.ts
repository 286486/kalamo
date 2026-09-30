// SVG gradients folded into Kalamo's (ADR-0026): SVG's reflect and repeat are unrolled into stops, so
// what is stored draws the same pixels. Core's mapGradient then applies whatever maps the gradient's
// own space into the Node's coordinates (gradientTransform, objectBoundingBox, a leaf's bake).
import {
  type ColorStop,
  colorAt,
  colorSteps,
  type Gradient,
  type Point,
  round3,
} from "@kalamo/core";

/** A gradient's geometry in its own space, as SVG's attributes give it. */
export type Geometry =
  | { type: "linear"; p1: Point; p2: Point }
  | { type: "radial"; c: Point; r: number; f: Point };

/** The geometry as a Kalamo gradient with `stops`: SVG's circle is a radial of aspectRatio 1. */
export const asGradient = (g: Geometry, stops: ColorStop[]): Gradient =>
  g.type === "linear"
    ? { type: "linear", stops, start: g.p1, end: g.p2 }
    : { type: "radial", stops, center: g.c, radius: g.r, aspectRatio: 1, angle: 0, focus: g.f };

/** Where `q` falls along the gradient: 0 at the first stop, 1 at the last. */
function along(g: Geometry, q: Point): number {
  if (g.type === "linear") {
    const [dx, dy] = [g.p2.x - g.p1.x, g.p2.y - g.p1.y];
    return ((q.x - g.p1.x) * dx + (q.y - g.p1.y) * dy) / (dx * dx + dy * dy);
  }
  // The t whose circle, centred at f + t(c - f) with radius t·r, passes through q.
  const [wx, wy] = [q.x - g.f.x, q.y - g.f.y];
  const [ex, ey] = [g.c.x - g.f.x, g.c.y - g.f.y];
  const a = ex * ex + ey * ey - g.r * g.r;
  const b = wx * ex + wy * ey;
  const c = wx * wx + wy * wy;
  // a < 0 with the focus inside the circle, so one root is not negative.
  return Math.abs(a) < 1e-12 ? c / (2 * b) : (b - Math.sqrt(b * b - a * c)) / a;
}

// ponytail: a gradient far smaller than its element unrolls into at most this many periods, then
// pads; raise it if a real file needs more.
const MAX_PERIODS = 64;

/**
 * SVG's reflect or repeat as stops over a pad gradient that covers `corners` (the element's visible
 * bounds in the gradient's own space), so pad draws the same colours.
 */
export function unroll(
  g: Geometry,
  stops: ColorStop[],
  spread: "reflect" | "repeat",
  corners: Point[],
): { g: Geometry; stops: ColorStop[] } {
  const ts = corners.map((q) => along(g, q));
  let from = g.type === "linear" ? Math.floor(Math.min(0, ...ts)) : 0;
  let to = Math.ceil(Math.max(1, ...ts));
  if (to - from > MAX_PERIODS) {
    from = Math.max(from, -MAX_PERIODS / 2);
    to = from + MAX_PERIODS;
  }
  // Each period holds its first and last colours out to its ends, so periods meet at a hard edge.
  const [first, last] = [stops[0], stops.at(-1)] as [ColorStop, ColorStop];
  // Midpoints are dropped: Kalamo never writes reflect or repeat to carry them (ADR-0081).
  const whole = [
    ...(first.offset > 0 ? [{ ...first, offset: 0 }] : []),
    ...stops,
    ...(last.offset < 1 ? [{ ...last, offset: 1 }] : []),
  ].map(({ offset, color }) => ({ offset, color }));
  const out: ColorStop[] = [];
  for (let k = from; k < to; k++) {
    const period =
      spread === "reflect" && Math.abs(k) % 2 === 1
        ? whole.map((s) => ({ ...s, offset: 1 - s.offset })).reverse()
        : whole;
    for (const s of period) out.push({ ...s, offset: round3((k - from + s.offset) / (to - from)) });
  }
  if (g.type === "linear") {
    const [dx, dy] = [g.p2.x - g.p1.x, g.p2.y - g.p1.y];
    const at = (t: number) => ({ x: g.p1.x + t * dx, y: g.p1.y + t * dy });
    return { g: { type: "linear", p1: at(from), p2: at(to) }, stops: out };
  }
  // Scaling the circles about the focus by `to` keeps every t / to on the same circle.
  const c = { x: g.f.x + to * (g.c.x - g.f.x), y: g.f.y + to * (g.c.y - g.f.y) };
  return { g: { ...g, c, r: g.r * to }, stops: out };
}

/** A stop as read, and whether export inserted it to draw a midpoint (`kalamo:simulated`). */
export type ReadStop = ColorStop & { marked: boolean };

/** How far, in 8-bit steps, an inserted stop may lie from its midpoint's curve and be dropped. */
const ON_CURVE = 2;

/**
 * The Color Stops of the stops read (ADR-0082). Between two unmarked stops, the marked ones are
 * dropped when every one lies within ON_CURVE of the first's midpoint curve. Otherwise, and outside the
 * unmarked stops, they are kept as SVG draws them, and so is the straight blend into each: only an
 * unmarked stop followed by an unmarked stop keeps its midpoint. `keptInserted` is whether any
 * marked stop was kept.
 */
export function unmark(read: ReadStop[]): { stops: ColorStop[]; keptInserted: boolean } {
  const real = read.flatMap((s, i) => (s.marked ? [] : [i]));
  const dropped = new Set<ReadStop>();
  real.slice(0, -1).forEach((i, r) => {
    const j = real[r + 1] as number;
    const curve = [read[i], read[j]] as ColorStop[];
    const span = read.slice(i + 1, j);
    if (span.every((m) => colorSteps(m.color, colorAt(curve, m.offset)) <= ON_CURVE)) {
      for (const m of span) dropped.add(m);
    }
  });
  const left = read.filter((s) => !dropped.has(s));
  const stops = left.map(({ marked, midpoint, ...s }, k) => {
    const next = left[k + 1];
    const keepsMidpoint = midpoint !== undefined && !marked && next && !next.marked;
    return { ...s, offset: round3(s.offset), ...(keepsMidpoint && { midpoint }) };
  });
  return { stops, keptInserted: left.some((s) => s.marked) };
}
