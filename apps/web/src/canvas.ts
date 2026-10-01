import { bounds, type Document, formatPath, type Rect, Shape, shapeSegments } from "@kalamo/core";
import { forNewArt, leaving } from "./isolation.ts";
import { colorOf, labelOf, type Peers, type visibleAreas } from "./presence.ts";
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

/** An Agent's Working Area pill, in document coordinates, and the whole `intent` its tooltip shows. */
export type AreaPill = Rect & { intent: string | null };

/** An `intent` longer than this is cut, ending in an ellipsis (ADR-0090). */
const PILL_INTENT = 48;

/**
 * Each Agent's Working Area, dashed in its Actor's colour, with a pill on its top-left corner
 * holding the label and `intent` (ADR-0090). Returns the pills, which the pointer hovers but never
 * hits.
 */
export function drawAreas(
  ctx: CanvasRenderingContext2D,
  areas: ReturnType<typeof visibleAreas>,
  names: ReadonlyMap<string, string>,
  scale: number,
): AreaPill[] {
  ctx.save();
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const pills = areas.map(({ actor, bounds: b, intent }) => {
    const color = colorOf(actor);
    ctx.lineWidth = 1 / scale;
    ctx.setLineDash([4 / scale, 3 / scale]);
    ctx.strokeStyle = color;
    ctx.strokeRect(b.x, b.y, b.width, b.height);
    const cut =
      intent && intent.length > PILL_INTENT ? `${intent.slice(0, PILL_INTENT - 1)}…` : intent;
    const text = cut ? `${labelOf(names, actor)} · ${cut}` : labelOf(names, actor);
    const width = ctx.measureText(text).width + 8;
    ctx.save();
    // Screen px from here, the pill's bottom-left on the area's top-left corner.
    ctx.translate(b.x, b.y);
    ctx.scale(1 / scale, 1 / scale);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(0, -16, width, 16, 4);
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(text, 4, -8);
    ctx.restore();
    return { x: b.x, y: b.y - 16 / scale, width: width / scale, height: 16 / scale, intent };
  });
  ctx.restore();
  return pills;
}

/**
 * The other Peers' Selections, as each selected Node's bounds 1 screen px wide, and cursors, as an
 * arrow with a pill holding the label, each in its Actor's colour (ADR-0090). Ids `doc` lacks are
 * skipped.
 */
export function drawPeers(
  ctx: CanvasRenderingContext2D,
  doc: Document,
  peers: Peers,
  names: ReadonlyMap<string, string>,
  scale: number,
) {
  ctx.save();
  ctx.lineWidth = 1 / scale;
  for (const { actor, selection } of peers.values()) {
    ctx.strokeStyle = colorOf(actor);
    for (const id of selection) {
      const node = doc.nodes.get(id);
      const b = node && bounds(doc, node);
      if (b) ctx.strokeRect(b.x, b.y, b.width, b.height);
    }
  }
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (const { actor, cursor } of peers.values()) {
    if (!cursor) continue;
    const color = colorOf(actor);
    const label = labelOf(names, actor);
    ctx.save();
    // Screen px from here, with ARROW's tip at the cursor.
    ctx.translate(cursor.x, cursor.y);
    ctx.scale(1 / scale, 1 / scale);
    ctx.translate(-4, -2);
    const arrow = new Path2D(ARROW);
    ctx.fillStyle = color;
    ctx.fill(arrow);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#FFFFFF";
    ctx.stroke(arrow);
    const width = ctx.measureText(label).width + 8;
    ctx.beginPath();
    ctx.roundRect(12, 14, width, 16, 4);
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(label, 16, 22);
    ctx.restore();
  }
  ctx.restore();
}
