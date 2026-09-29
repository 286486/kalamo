import { type Document, type Rect, union } from "@kalamo/core";

/** Maps document points to screen (CSS px): screen = doc * scale + (x, y). */
export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

/** Illustrator's zoom range, 3.13% to 6400%. */
const MIN_SCALE = 0.0313;
const MAX_SCALE = 64;
/** The levels Illustrator's Zoom In and Zoom Out step through. */
const LEVELS = [
  MIN_SCALE,
  1 / 24,
  1 / 16,
  1 / 12,
  1 / 8,
  1 / 6,
  1 / 4,
  1 / 3,
  1 / 2,
  2 / 3,
  1,
  1.5,
  2,
  3,
  4,
  6,
  8,
  12,
  16,
  24,
  32,
  48,
  MAX_SCALE,
];

/** The next zoom level above (`dir` 1) or below (-1) `scale`, or the end of the range. */
export const zoomStep = (scale: number, dir: 1 | -1) =>
  (dir > 0 ? LEVELS.find((l) => l > scale * 1.001) : LEVELS.findLast((l) => l < scale / 1.001)) ??
  (dir > 0 ? MAX_SCALE : MIN_SCALE);

/** Every Artboard, which Fit Artboard in Window shows. */
export const artboardsRect = (doc: Document) =>
  union(doc.artboards.map((a) => a.frame)) ?? { x: 0, y: 0, width: 100, height: 100 };

export const toDoc = (v: Viewport, sx: number, sy: number) => ({
  x: (sx - v.x) / v.scale,
  y: (sy - v.y) / v.scale,
});

/** Multiplies the zoom by `factor`, keeping the document point under (sx, sy) fixed. */
export function zoomAt(v: Viewport, factor: number, sx: number, sy: number): Viewport {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
  const p = toDoc(v, sx, sy);
  return { x: sx - p.x * scale, y: sy - p.y * scale, scale };
}

/** Shows all of `rect`, centred in a `width` x `height` screen with `margin` on every side. */
export function fit(rect: Rect, width: number, height: number, margin = 20): Viewport {
  const fits = Math.min((width - 2 * margin) / rect.width, (height - 2 * margin) / rect.height);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fits));
  return {
    x: width / 2 - (rect.x + rect.width / 2) * scale,
    y: height / 2 - (rect.y + rect.height / 2) * scale,
    scale,
  };
}
