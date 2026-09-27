import { SELECTION, SLOP } from "./canvas.ts";
import { useStore } from "./store.ts";
import type { CanvasTool } from "./toolbox.ts";
import { drawing, finishPen, pathD, penClick } from "./tools.ts";

/** Where the rubber band ends, in document coordinates. */
let pointer: [number, number] | null = null;

/** Clicks place Corner Anchors; see tools.ts. */
export const penTool: CanvasTool = {
  title: "Pen Tool",
  shortcut: "P",
  icon: "M8 1 L12 8 L10 14 H6 L4 8 Z M8 1 V8 M7 8 A1 1 0 1 0 9 8",
  cursor: "crosshair",
  down: (e) => penClick([e.x, e.y], SLOP / e.viewport.scale),
  move(e) {
    pointer = [e.x, e.y];
    e.redraw();
  },
  leave(e) {
    pointer = null;
    e.redraw();
  },
  onKey(keys) {
    // Enter and Esc end the path.
    if (keys === "Enter" || keys === "Escape") finishPen();
  },
  draw(ctx, _doc, scale) {
    const s = useStore.getState();
    const { pen, fillStroke } = s;
    if (!pen) return;
    // The path so far in its Fill and Stroke, then its outline, rubber band and Anchors.
    const rubber = drawing(s) && pointer;
    const points = rubber ? [...pen.points, rubber] : pen.points;
    const path = new Path2D(pathD(points, pen.closed));
    if (fillStroke.fill) {
      ctx.fillStyle = fillStroke.fill;
      ctx.fill(path);
    }
    if (fillStroke.stroke) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = fillStroke.stroke;
      ctx.stroke(path);
    }
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = SELECTION;
    ctx.stroke(path);
    const r = 2.5 / scale;
    for (const [px, py] of pen.points) ctx.strokeRect(px - r, py - r, 2 * r, 2 * r);
  },
};
