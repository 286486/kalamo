import type { Rect } from "@zibel/core";
import {
  cancelDrag,
  commitDrag,
  dragged,
  drawMarquee,
  type Mods,
  type Press,
  rectOf,
  SLOP,
} from "./canvas.ts";
import { combine, editable, hitTest, marquee } from "./selection.ts";
import { useStore } from "./store.ts";
import type { CanvasTool } from "./toolbox.ts";

export const ARROW = "M4 2 L4 13 L7 10 L9 14 L11 13 L9 9 L13 9 Z";

/** A press on the canvas: moving objects, or drawing a marquee. */
let gesture:
  | (Press & ({ kind: "move"; nodeIds: string[] } | { kind: "marquee"; mods: Mods }))
  | null = null;
let marqueeRect: Rect | null = null;

/** Illustrator's black arrow: selects and moves whole objects. */
export const selectionTool: CanvasTool = {
  title: "Selection Tool",
  shortcut: "V",
  icon: ARROW,
  iconFill: "currentColor",
  cursor: "default",
  down(e) {
    const { doc } = e;
    const { selection } = useStore.getState();
    const start = { x: e.x, y: e.y };
    const mods = { shift: e.shift, alt: e.alt };
    useStore.setState({ notice: null });
    const hit = hitTest(e.ctx, doc, start.x, start.y, SLOP / e.viewport.scale);
    if (hit && mods.shift) {
      useStore.setState({ selection: combine(selection, [hit], mods) });
      return;
    }
    e.capture();
    if (hit) {
      // Pressing a selected object keeps the Selection, so all of it that is editable moves.
      const kept = selection.includes(hit);
      if (!kept) useStore.setState({ selection: [hit] });
      const nodeIds = kept ? selection.filter((id) => editable(doc, doc.nodes.get(id))) : [hit];
      gesture = { kind: "move", start, nodeIds, moved: false };
    } else {
      gesture = { kind: "marquee", start, mods, moved: false };
    }
  },
  move(e) {
    const g = gesture;
    const d = g && dragged(g, e);
    if (!g || !d) return;
    if (g.kind === "move") {
      useStore.setState({ drag: { nodeIds: g.nodeIds, dx: d[0], dy: d[1], commandId: null } });
    } else {
      marqueeRect = rectOf(g.start, e);
      e.redraw();
    }
  },
  /** Releasing commits a move, or applies the marquee (a click if it never moved). */
  up(e) {
    const g = gesture;
    gesture = null;
    if (g?.kind === "marquee") {
      const ids = g.moved && marqueeRect ? marquee(e.doc, marqueeRect) : [];
      useStore.setState({ selection: combine(useStore.getState().selection, ids, g.mods) });
      marqueeRect = null;
      e.redraw();
    } else if (g?.moved) commitDrag();
  },
  cancel(e) {
    gesture = null;
    marqueeRect = null;
    e.redraw();
    cancelDrag();
  },
  draw(ctx, _doc, scale) {
    if (marqueeRect) drawMarquee(ctx, marqueeRect, scale);
  },
};
