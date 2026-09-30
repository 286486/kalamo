import { parsePath, type Segment } from "./path.ts";

/** One straight edge of a flattened frame, from (x1, y1) to (x2, y2). */
type Edge = [number, number, number, number];

/** A usable stretch of one band of a shaped frame: from `x`, `width` wide (ADR-0078). */
export interface Span {
  x: number;
  width: number;
}

/** Straight pieces per Bézier: a quarter circle of radius 100 in 32 pieces strays at most 0.03 pt. */
const STEPS = 32;

/** The frame's outline as straight edges, each subpath closed, curves flattened. */
export function frameEdges(segments: Segment[]): Edge[] {
  const edges: Edge[] = [];
  let [cx, cy, sx, sy] = [0, 0, 0, 0];
  const to = (x: number, y: number) => {
    if (x !== cx || y !== cy) edges.push([cx, cy, x, y]);
    [cx, cy] = [x, y];
  };
  const close = () => to(sx, sy);
  for (const { cmd, args: a } of segments) {
    if (cmd === "M") {
      close();
      [cx, cy, sx, sy] = [a[0] as number, a[1] as number, a[0] as number, a[1] as number];
    } else if (cmd === "L") to(a[0] as number, a[1] as number);
    else if (cmd === "Z") close();
    else {
      const [x0, y0] = [cx, cy];
      const pts = cmd === "C" ? a : [a[0], a[1], a[0], a[1], a[2], a[3]];
      const [x1, y1, x2, y2, x3, y3] = pts as number[];
      for (let k = 1; k <= STEPS; k++) {
        const t = k / STEPS;
        const u = 1 - t;
        if (cmd === "Q") {
          to(
            u * u * x0 + 2 * u * t * (x1 as number) + t * t * (x3 as number),
            u * u * y0 + 2 * u * t * (y1 as number) + t * t * (y3 as number),
          );
        } else {
          const [b0, b1, b2, b3] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
          to(
            b0 * x0 + b1 * (x1 as number) + b2 * (x2 as number) + b3 * (x3 as number),
            b0 * y0 + b1 * (y1 as number) + b2 * (y2 as number) + b3 * (y3 as number),
          );
        }
      }
    }
  }
  close();
  return edges;
}

/** Whether (x, y) is inside the edges by the nonzero rule. */
function inside(edges: Edge[], x: number, y: number): boolean {
  let winding = 0;
  for (const [x1, y1, x2, y2] of edges) {
    if (y1 <= y !== y2 <= y) {
      const at = x1 + ((y - y1) / (y2 - y1)) * (x2 - x1);
      if (at > x) winding += y2 > y1 ? 1 : -1;
    }
  }
  return winding !== 0;
}

/**
 * The spans of the band `top` to `bottom`, left to right: each maximal stretch the frame's inside
 * covers across the whole band, as Inkscape 1.2.2 scans `shape-inside` (ADR-0078). Between the
 * places where an edge crosses the band, the band is wholly inside or wholly outside.
 */
export function frameSpans(edges: Edge[], top: number, bottom: number): Span[] {
  const blocked: [number, number][] = [];
  for (const [x1, y1, x2, y2] of edges) {
    if (Math.max(y1, y2) < top || Math.min(y1, y2) > bottom) continue;
    const at = (y: number) => (y1 === y2 ? x1 : x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    const [ya, yb] = [Math.max(Math.min(y1, y2), top), Math.min(Math.max(y1, y2), bottom)];
    const [xa, xb] = y1 === y2 ? [x1, x2] : [at(ya), at(yb)];
    blocked.push([Math.min(xa, xb), Math.max(xa, xb)]);
  }
  blocked.sort((a, b) => a[0] - b[0]);
  const spans: Span[] = [];
  let edge = -Infinity;
  const middle = (top + bottom) / 2;
  for (const [a, b] of blocked) {
    if (a > edge && edge > -Infinity && inside(edges, (edge + a) / 2, middle)) {
      spans.push({ x: edge, width: a - edge });
    }
    edge = Math.max(edge, b);
  }
  return spans;
}

/** Frame edges by `frame` data, parsed once. ponytail: unbounded; key by Node if it grows. */
const cache = new Map<string, Edge[]>();

/** The edges of a stored `frame`. */
export function edgesOf(frame: string): Edge[] {
  let edges = cache.get(frame);
  if (!edges) {
    edges = frameEdges(parsePath(frame, "frame"));
    cache.set(frame, edges);
  }
  return edges;
}
