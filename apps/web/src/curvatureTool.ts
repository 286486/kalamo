import { formatPath, fromAnchors } from "@zibel/core";
import { cancelDrag, commitDrag, drawDrawing, SELECTION, SLOP } from "./canvas.ts";
import {
  curvatureCancel,
  curvatureDown,
  curvatureDrag,
  curvaturePressed,
  curvatureUp,
  curveThrough,
} from "./curvature.ts";
import { anchorKey, anchorsOf, hasAnchors } from "./direct.ts";
import { useStore } from "./store.ts";
import type { CanvasTool } from "./toolbox.ts";
import { drawing, finishPen, pathD } from "./tools.ts";

type Point = [number, number];

/** Where the rubber band's next point is, in document coordinates. */
let pointer: Point | null = null;

/** A point as Illustrator's Curvature tool shows it: a circle if Smooth, a square if Corner. */
function drawPoint(
  ctx: CanvasRenderingContext2D,
  [x, y]: Point,
  smooth: boolean,
  solid: boolean,
  scale: number,
) {
  const r = 2.5 / scale;
  ctx.beginPath();
  if (smooth) ctx.arc(x, y, r, 0, 2 * Math.PI);
  else ctx.rect(x - r, y - r, 2 * r, 2 * r);
  ctx.fillStyle = solid ? SELECTION : "#FFFFFF";
  ctx.fill();
  ctx.stroke();
}

/** Clicks place Smooth points and the curve runs through them; see curvature.ts. */
export const curvatureTool: CanvasTool = {
  title: "Curvature Tool",
  shortcut: "Shift+~",
  icon: "M2 13 C4 4 12 12 14 3 M1.5 12.5 h1 v1 h-1 Z M13.5 2.5 h1 v1 h-1 Z",
  cursor: "crosshair",
  down(e) {
    e.capture();
    curvatureDown([e.x, e.y], SLOP / e.viewport.scale, e.alt);
    e.redraw();
  },
  move(e) {
    pointer = [e.x, e.y];
    if (curvaturePressed()) curvatureDrag([e.x, e.y]);
    e.redraw();
  },
  up(e) {
    curvatureUp();
    commitDrag();
    e.redraw();
  },
  cancel(redraw) {
    curvatureCancel();
    cancelDrag();
    redraw();
  },
  leave(e) {
    pointer = null;
    e.redraw();
  },
  onKey(keys) {
    if (keys === "Enter" || keys === "Escape") finishPen();
  },
  draw(ctx, _doc, scale) {
    const s = useStore.getState();
    const { pen } = s;
    if (!pen?.points) return;
    // The rubber band: the curve as it would run through a point at the pointer.
    const d =
      drawing(s) && pointer && !curvaturePressed()
        ? pathD(curveThrough([...pen.points, { at: pointer, smooth: true }], false), false)
        : pathD(pen.anchors, pen.closed);
    drawDrawing(ctx, new Path2D(d), s.fillStroke, scale);
    for (const [i, p] of pen.points.entries()) {
      drawPoint(ctx, p.at, p.smooth, i === pen.points.length - 1, scale);
    }
  },
  /** Its outline and Anchors, as circles and squares; selected ones solid. */
  drawSelected(ctx, doc, node, scale) {
    if (!hasAnchors(node)) return false;
    const { anchors } = useStore.getState();
    const subpaths = anchorsOf(doc, node);
    ctx.stroke(new Path2D(formatPath(fromAnchors(subpaths))));
    for (const [k, sub] of subpaths.entries()) {
      for (const [i, a] of sub.anchors.entries()) {
        const on = anchors.includes(anchorKey(node.id, k, i));
        drawPoint(ctx, a.anchor, a.type === "smooth", on, scale);
      }
    }
    return true;
  },
};
