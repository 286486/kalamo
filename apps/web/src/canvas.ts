import type { Rect } from "@zibel/core";
import { send, useStore } from "./store.ts";
import type { ToolEvent } from "./toolbox.ts";

/** Illustrator's first Layer colour, used for the Selection and the marquee. */
export const SELECTION = "#4F80FF";
/** The Selection and Direct Selection tools' icon: Illustrator's arrow, black and white. */
export const ARROW = "M4 2 L4 13 L7 10 L9 14 L11 13 L9 9 L13 9 Z";
/** Screen px the pointer may wander before a press becomes a drag, and the hit tolerance. */
export const SLOP = 3;

export type Point = { x: number; y: number };
export type Mods = { shift: boolean; alt: boolean };
/** A press that may become a drag. */
export type Press = { start: Point; moved: boolean };

export const rectOf = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

/** How far the press has been dragged, or null while it is still a click. */
export function dragged(g: Press, e: ToolEvent): [number, number] | null {
  const [dx, dy] = [e.x - g.start.x, e.y - g.start.y];
  g.moved ||= Math.hypot(dx, dy) * e.viewport.scale >= SLOP;
  return g.moved ? [dx, dy] : null;
}

export function drawMarquee(ctx: CanvasRenderingContext2D, rect: Rect, scale: number) {
  ctx.lineWidth = 1 / scale;
  ctx.strokeStyle = SELECTION;
  ctx.setLineDash([4 / scale, 4 / scale]);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.setLineDash([]);
}

/** Releasing a drag commits it as one Transaction. */
export function commitDrag() {
  const { drag, edit } = useStore.getState();
  // One path_edit per path the drag reshaped (ADR-0032), and one transform for what moved whole.
  if (edit && edit.commandIds === null) {
    const commandIds = edit.inputs.map((input) => send({ type: "path_edit", input }));
    useStore.setState({ edit: { ...edit, commandIds } });
  }
  if (drag && drag.commandId === null) {
    // ponytail: TransformInput takes at most 1000 nodeIds: a larger drag crashes preview() and
    // is closed with 1007 by the DO; chunk the command or lift the max when Documents grow.
    const translate = { x: drag.dx, y: drag.dy };
    const commandId = send({ type: "transform", input: { nodeIds: drag.nodeIds, translate } });
    useStore.setState({ drag: { ...drag, commandId } });
  }
}

/** Drops a drag not yet sent. */
export function cancelDrag() {
  if (useStore.getState().drag?.commandId === null) useStore.setState({ drag: null });
  if (useStore.getState().edit?.commandIds === null) useStore.setState({ edit: null });
}
