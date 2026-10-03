import type { Rect } from "@kalamo/core";
import {
  ARROW,
  cancelDrag,
  commitDrag,
  dragged,
  drawMarquee,
  type Mods,
  type Press,
  rectOf,
  SLOP,
} from "./canvas.ts";
import { exitLevel, isolate } from "./isolation.ts";
import { combine, editable, hitTest, marquee } from "./selection.ts";
import { canEdit, unheld, useStore } from "./store.ts";
import type { CanvasTool, ToolEvent } from "./toolbox.ts";

/** A press on the canvas: moving objects under `hit`, or drawing a marquee. */
let gesture:
  | (Press & ({ kind: "move"; hit: string; nodeIds: string[] } | { kind: "marquee"; mods: Mods }))
  | null = null;
let marqueeRect: Rect | null = null;

/** The last press was released without a drag, so a second press makes a double-click. */
let clicked = false;

/**
 * A double-click (ADR-0057): on a Group it isolates it and selects what is under the pointer
 * inside it; where nothing in scope is hit it goes up one level.
 */
function doubleClick(e: ToolEvent, hit: string | null) {
  const { doc } = e;
  const { isolated } = useStore.getState();
  const into = hit === null ? null : isolate(doc, hit);
  if (into !== null) {
    const under = hitTest(e.ctx, doc, e.x, e.y, SLOP / e.viewport.scale, { scope: into });
    useStore.setState({ isolated: into, selection: under ? [under] : [] });
  } else if (hit === null && isolated !== null) {
    useStore.setState(exitLevel(doc, isolated));
  }
}

/** Illustrator's black arrow: selects and moves whole objects, or copies them with Alt held. */
export const selectionTool: CanvasTool = {
  title: "Selection Tool",
  shortcut: "V",
  icon: ARROW,
  iconFill: "currentColor",
  cursor: "default",
  down(e) {
    const { doc } = e;
    const { selection, isolated: scope } = useStore.getState();
    const start = { x: e.x, y: e.y };
    const mods = { shift: e.shift, alt: e.alt };
    useStore.setState({ notice: null });
    const hit = hitTest(e.ctx, doc, start.x, start.y, SLOP / e.viewport.scale, { scope });
    if (hit && mods.shift) {
      clicked = false;
      useStore.setState({ selection: combine(selection, [hit], mods) });
      return;
    }
    e.capture();
    if (hit) {
      // Pressing a selected object keeps the Selection, so all of it that is editable moves.
      const kept = selection.includes(hit);
      if (!kept) useStore.setState({ selection: [hit] });
      // A viewer's press selects but moves and copies nothing (ADR-0047).
      const nodeIds = !canEdit(useStore.getState())
        ? []
        : kept
          ? selection.filter((id) => editable(doc, doc.nodes.get(id)))
          : [hit];
      gesture = { kind: "move", start, hit, nodeIds, moved: false };
    } else {
      gesture = { kind: "marquee", start, mods, moved: false };
    }
  },
  move(e) {
    const g = gesture;
    const d = g && dragged(g, e);
    if (!g || !d) return;
    if (g.kind === "move") {
      if (g.nodeIds.length === 0) return;
      // Alt held copies instead (ADR-0076); the preview follows it until the release decides.
      const drag = { nodeIds: g.nodeIds, dx: d[0], dy: d[1], copy: e.alt };
      useStore.setState({ drag });
    } else {
      marqueeRect = rectOf(g.start, e);
      e.redraw();
    }
  },
  /** Releasing commits a move, or applies the marquee (a click if it never moved). */
  up(e) {
    const g = gesture;
    gesture = null;
    const double = !!g && !g.moved && clicked && e.clicks === 2;
    clicked = !!g && !g.moved;
    if (g?.kind === "marquee") {
      const { selection, isolated } = useStore.getState();
      const ids = g.moved && marqueeRect ? marquee(e.doc, marqueeRect, isolated) : [];
      useStore.setState({ selection: combine(selection, ids, g.mods) });
      marqueeRect = null;
      e.redraw();
    } else if (g?.moved) {
      const { drag } = useStore.getState();
      if (drag) useStore.setState({ drag: { ...drag, copy: e.alt } });
      commitDrag(unheld("a Selection tool drag moves whole Nodes"));
    }
    if (g && double) doubleClick(e, g.kind === "move" ? g.hit : null);
  },
  /** Alt pressed or released mid-drag switches the preview between moving and copying. */
  keyChange(key) {
    const { drag } = useStore.getState();
    if (gesture?.kind === "move" && drag && drag.copy !== key.alt) {
      useStore.setState({ drag: { ...drag, copy: key.alt } });
    }
    return false;
  },
  cancel(redraw) {
    gesture = null;
    clicked = false;
    marqueeRect = null;
    redraw();
    cancelDrag();
  },
  draw(ctx, _doc, scale) {
    if (marqueeRect) drawMarquee(ctx, marqueeRect, scale);
  },
};
