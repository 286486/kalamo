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
