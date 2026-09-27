import { dragged, type Press, SELECTION, SLOP } from "./canvas.ts";
import { useStore } from "./store.ts";
import type { CanvasTool } from "./toolbox.ts";
import {
  constrain,
  drawing,
  finishPen,
  pathD,
  penCancel,
  penDown,
  penDrag,
  penPressed,
  penUp,
} from "./tools.ts";

type Point = [number, number];

/** Where the rubber band ends, in document coordinates, and whether Shift constrains it. */
let pointer: { at: Point; shift: boolean } | null = null;
let gesture: Press | null = null;

/** Clicks place Corner Anchors and drags Smooth ones; see tools.ts. */
export const penTool: CanvasTool = {
  title: "Pen Tool",
  shortcut: "P",
  icon: "M8 1 L12 8 L10 14 H6 L4 8 Z M8 1 V8 M7 8 A1 1 0 1 0 9 8",
  cursor: "crosshair",
  down(e) {
    e.capture();
    gesture = { start: { x: e.x, y: e.y }, moved: false };
    penDown([e.x, e.y], SLOP / e.viewport.scale, e.shift);
  },
  move(e) {
    pointer = { at: [e.x, e.y], shift: e.shift };
    if (gesture && dragged(gesture, e)) penDrag([e.x, e.y], e);
    e.redraw();
  },
  up(e) {
    gesture = null;
    penUp();
    e.redraw();
  },
  cancel(redraw) {
    gesture = null;
    penCancel();
    redraw();
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
    // The path so far in its Fill and Stroke, then its outline, rubber band, Anchors and Handles.
    const last = pen.anchors.at(-1);
    let anchors = pen.anchors;
    if (drawing(s) && pointer && last && !penPressed()) {
      const at = pointer.shift ? constrain(last.anchor, pointer.at) : pointer.at;
      anchors = [...anchors, { anchor: at, handleIn: null, handleOut: null }];
    }
    const path = new Path2D(pathD(anchors, pen.closed));
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
    ctx.fillStyle = SELECTION;
    ctx.stroke(path);
    const r = 2.5 / scale;
    // The last Anchor is solid, as the selected one, and shows its Handles; so does the first while
    // a drag on it closes the path.
    for (const a of pen.anchors) {
      const [x, y] = a.anchor;
      if (a === last) ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
      else ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
      if (a !== last && !(a === pen.anchors[0] && penPressed())) continue;
      for (const h of [a.handleIn, a.handleOut]) {
        if (!h) continue;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(h[0], h[1]);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(h[0], h[1], r * 0.8, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  },
};
