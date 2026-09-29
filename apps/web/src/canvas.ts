import { formatPath, type Rect, Shape, shapeSegments } from "@kalamo/core";
import { forNewArt, leaving } from "./isolation.ts";
import { copyInput, type PendingCreate } from "./receive.ts";
import { send, useStore } from "./store.ts";
import type { ToolEvent } from "./toolbox.ts";
import type { FillStroke } from "./tools.ts";

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

/** A path being drawn: in the current Fill and Stroke, then its outline, with the Selection's colour set. */
export function drawDrawing(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  { fill, stroke }: Pick<FillStroke, "fill" | "stroke">,
  scale: number,
) {
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill(path);
  }
  if (stroke) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = stroke;
    ctx.stroke(path);
  }
  ctx.lineWidth = 1 / scale;
  ctx.strokeStyle = SELECTION;
  ctx.fillStyle = SELECTION;
  ctx.stroke(path);
}

/** A Live Shape's or path's outline, from core's shapeSegments; null for other Nodes. */
export function shapePath(input: unknown): Path2D | null {
  const shape = Shape.safeParse(input);
  return shape.success ? new Path2D(formatPath(shapeSegments(shape.data))) : null;
}

type Paints = object[];
type Painted = {
  type: string;
  appearance?: { fills?: Paints; strokes?: Paints };
  children?: Painted[];
};
const firstColor = (paints?: Paints) => {
  const paint = paints?.[0];
  const color = paint && "color" in paint ? paint.color : null;
  return typeof color === "string" ? color : null;
};

/**
 * Drawn art in flight (ADR-0032): each Node and inline child in the Fill and Stroke it was sent
 * with, so a change to the Fill and Stroke boxes meanwhile does not repaint it.
 */
export function drawPending(
  ctx: CanvasRenderingContext2D,
  pending: PendingCreate[],
  scale: number,
) {
  const draw = (input: Painted) => {
    const path = shapePath(input);
    const { fills, strokes } = input.appearance ?? {};
    if (path)
      drawDrawing(ctx, path, { fill: firstColor(fills), stroke: firstColor(strokes) }, scale);
    for (const child of input.children ?? []) draw(child);
  };
  for (const p of pending) for (const input of p.nodes) draw(input);
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
    const s = useStore.getState();
    const doc = drag.copy ? s.doc : null;
    const commandId = doc
      ? send({ type: "duplicate", input: copyInput(doc, drag) })
      : send({ type: "transform", input: { nodeIds: drag.nodeIds, translate } });
    // An isolated leaf's copies land beside it, so the Isolation goes up a level, as for new art.
    const leave = doc ? leaving(s.isolated, forNewArt(doc, s)) : undefined;
    useStore.setState({ drag: { ...drag, commandId, ...(leave && { leave }) } });
  }
}

/** Drops a drag not yet sent. */
export function cancelDrag() {
  if (useStore.getState().drag?.commandId === null) useStore.setState({ drag: null });
  if (useStore.getState().edit?.commandIds === null) useStore.setState({ edit: null });
}
