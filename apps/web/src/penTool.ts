import { anchorPointTool } from "./anchorTools.ts";
import { dragged, drawDrawing, type Press, SLOP } from "./canvas.ts";
import { directTool } from "./directTool.ts";
import { useStore } from "./store.ts";
import type { CanvasTool } from "./toolbox.ts";
import {
  constrain,
  drawing,
  finishPen,
  pathD,
  penCancel,
  penClosing,
  penDown,
  penDrag,
  penPressed,
  penUp,
} from "./tools.ts";

type Point = [number, number];

/** Where the rubber band ends, in document coordinates, and whether Shift constrains it. */
let pointer: { at: Point; shift: boolean } | null = null;
let gesture: Press | null = null;
/** Alt at the press, before drawing: the press is the Anchor Point tool's (research 06 §1). */
let converting = false;

/** Clicks place Corner Anchors and drags Smooth ones; see tools.ts. */
export const penTool: CanvasTool = {
  title: "Pen Tool",
  shortcut: "P",
  icon: "M8 1 L12 8 L10 14 H6 L4 8 Z M8 1 V8 M7 8 A1 1 0 1 0 9 8",
  cursor: "crosshair",
  altCursor: anchorPointTool.cursor,
  down(e) {
    converting = e.alt && !drawing(useStore.getState());
    if (converting) {
      anchorPointTool.down(e);
      return;
    }
    e.capture();
    gesture = { start: { x: e.x, y: e.y }, moved: false };
    penDown([e.x, e.y], SLOP / e.viewport.scale, e.shift);
  },
  move(e) {
    if (converting) {
      anchorPointTool.move?.(e);
      return;
    }
    pointer = { at: [e.x, e.y], shift: e.shift };
    // ponytail: a modifier pressed or released applies at the next move, where Illustrator
    // applies it at once; replay the last move from Viewer's key handler if that shows.
    if (gesture && dragged(gesture, e)) penDrag([e.x, e.y], e);
    e.redraw();
  },
  up(e) {
    if (converting) {
      converting = false;
      anchorPointTool.up?.(e);
      return;
    }
    gesture = null;
    penUp();
    e.redraw();
  },
  cancel(redraw) {
    if (converting) anchorPointTool.cancel?.(redraw);
    converting = false;
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
    if ((keys !== "Enter" && keys !== "Escape") || !drawing(useStore.getState())) return false;
    finishPen();
    return true;
  },
  // A selected path shows its Anchors, which Auto Add/Delete and Alt act on.
  drawSelected: directTool.drawSelected,
  draw(ctx, _doc, scale) {
    const s = useStore.getState();
    const { pen, fillStroke } = s;
    // The Curvature tool draws its own.
    if (!pen || pen.curve || pen.pencil || pen.shape) return;
    // The path so far in its Fill and Stroke, then its outline, rubber band, Anchors and Handles.
    const last = pen.anchors.at(-1);
    let anchors = pen.anchors;
    if (drawing(s) && pointer && last && !penPressed()) {
      const at = pointer.shift ? constrain(last.anchor, pointer.at) : pointer.at;
      anchors = [...anchors, { anchor: at, handleIn: null, handleOut: null }];
    }
    const path = new Path2D(pathD(anchors, pen.closed));
    // A continued path is painted as its Node; see setPen.
    drawDrawing(
      ctx,
      path,
      pen.from ? { ...fillStroke, fill: null, stroke: null } : fillStroke,
      scale,
    );
    const r = 2.5 / scale;
    // The last Anchor is solid, as the selected one, and shows its Handles; so does the first while
    // a drag on it closes the path.
    for (const a of pen.anchors) {
      const [x, y] = a.anchor;
      if (a === last) ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
      else ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
      if (a !== last && !(a === pen.anchors[0] && penClosing())) continue;
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
