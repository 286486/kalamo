import { vi } from "vitest";

/**
 * A context whose paths are their d's bounding box, enough for rects: a Stroke is the band
 * `lineWidth` wide centred on the box's edge.
 */
export function boxContext() {
  vi.stubGlobal(
    "Path2D",
    class {
      constructor(readonly d: string) {}
    },
  );
  const box = (d: string, x: number, y: number, grow = 0) => {
    const n = d.match(/-?[\d.]+/g)?.map(Number) ?? [];
    const xs = n.filter((_, i) => i % 2 === 0);
    const ys = n.filter((_, i) => i % 2 === 1);
    return (
      Math.min(...xs) - grow <= x &&
      x <= Math.max(...xs) + grow &&
      Math.min(...ys) - grow <= y &&
      y <= Math.max(...ys) + grow
    );
  };
  const ctx = {
    lineWidth: 1,
    save() {},
    restore() {},
    setTransform() {},
    isPointInPath: (p: { d: string }, x: number, y: number) => box(p.d, x, y),
    isPointInStroke: (p: { d: string }, x: number, y: number) =>
      box(p.d, x, y, ctx.lineWidth / 2) && !box(p.d, x, y, -ctx.lineWidth / 2),
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

/**
 * A context whose paths are the polygon through their d's points, enough for a transformed rect's
 * straight `M L Z` path: a Stroke is the band `lineWidth` wide centred on its edges.
 */
export function polygonContext() {
  vi.stubGlobal(
    "Path2D",
    class {
      constructor(readonly d: string) {}
    },
  );
  type Point = readonly [number, number];
  const edges = (d: string) => {
    const n = d.match(/-?[\d.]+/g)?.map(Number) ?? [];
    const ps = n.flatMap((v, i): Point[] => (i % 2 === 0 ? [[v, n[i + 1] ?? 0]] : []));
    return ps.map((p, i): [Point, Point] => [p, ps[(i + 1) % ps.length] ?? p]);
  };
  const ctx = {
    lineWidth: 1,
    save() {},
    restore() {},
    setTransform() {},
    isPointInPath: (p: { d: string }, x: number, y: number) =>
      edges(p.d).filter(([[x0, y0], [x1, y1]]) => {
        if (y0 > y === y1 > y) return false;
        return x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
      }).length %
        2 ===
      1,
    isPointInStroke: (p: { d: string }, x: number, y: number) =>
      edges(p.d).some(([[x0, y0], [x1, y1]]) => {
        const [dx, dy] = [x1 - x0, y1 - y0];
        const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(x - x0 - t * dx, y - y0 - t * dy) <= ctx.lineWidth / 2;
      }),
  };
  return ctx as unknown as CanvasRenderingContext2D;
}
