import { dragged, drawDrawing, type Press } from "./canvas.ts";
import { forNewArt, leaving } from "./isolation.ts";
import type { ShapeBox } from "./receive.ts";
import { send, useStore } from "./store.ts";
import type { CanvasTool, KeyMods } from "./toolbox.ts";
import { NOTHING_DRAWN, newArtNode } from "./tools.ts";

type Point = [number, number];

/**
 * The box a drag from `press` to `p` draws (F-DRAW-01): Shift makes it a square, as big as the
 * drag's longer side, and Alt centres it on `press`. A drag in any direction gives a positive size.
 */
export function dragBox(
  press: Point,
  p: Point,
  { shift, alt }: Omit<KeyMods, "space">,
): Omit<ShapeBox, "type"> {
  let [dx, dy] = [p[0] - press[0], p[1] - press[1]];
  if (shift) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    [dx, dy] = [dx < 0 ? -side : side, dy < 0 ? -side : side];
  }
  if (alt) {
    const [w, h] = [Math.abs(dx), Math.abs(dy)];
    return { x: press[0] - w, y: press[1] - h, width: 2 * w, height: 2 * h };
  }
  return {
    x: Math.min(press[0], press[0] + dx),
    y: Math.min(press[1], press[1] + dy),
    width: Math.abs(dx),
    height: Math.abs(dy),
  };
}

/**
 * The drag under way: where it started, moved by Space, the pointer, and the modifiers, re-read
 * on every move and key. `box` is null until the drag passes SLOP.
 */
let drag: {
  type: ShapeBox["type"];
  gesture: Press;
  origin: Point;
  at: Point;
  box: ShapeBox | null;
} | null = null;

function update(p: Point, mods: KeyMods, moved: boolean) {
  if (!drag) return;
  // Space moves the whole shape: the origin follows the pointer, and sizing resumes from there.
  if (mods.space)
    drag.origin = [drag.origin[0] + p[0] - drag.at[0], drag.origin[1] + p[1] - drag.at[1]];
  drag.at = p;
  if (moved) drag.box = { type: drag.type, ...dragBox(drag.origin, p, mods) };
}

function outline({ type, x, y, width, height }: ShapeBox) {
  const path = new Path2D();
  if (type === "rect") path.rect(x, y, width, height);
  else path.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, 2 * Math.PI);
  return path;
}

/**
 * Sends the drag as one `create` (ADR-0032), placed as the Pen places new art; the Live Shape is
 * drawn until its Transaction arrives, which selects it (receive.ts).
 */
function finish(shape: ShapeBox) {
  const s = useStore.getState();
  if (!s.doc) return;
  const at = forNewArt(s.doc, s);
  const node = newArtNode({ ...s, ...at, doc: s.doc }, shape);
  if (!node) {
    useStore.setState({ notice: NOTHING_DRAWN });
    return;
  }
  const commandId = send({ type: "create", nodes: [node] });
  useStore.setState({
    pen: { anchors: [], closed: true, commandId, shape, leave: leaving(s.isolated, at) },
  });
}

/** A drag draws a Live Shape of `type`, previewed in the current Fill and Stroke until release. */
const shapeTool = (
  type: ShapeBox["type"],
  tool: Pick<CanvasTool, "title" | "shortcut" | "icon">,
): CanvasTool => ({
  ...tool,
  cursor: "crosshair",
  down(e) {
    e.capture();
    drag = {
      type,
      gesture: { start: { x: e.x, y: e.y }, moved: false },
      origin: [e.x, e.y],
      at: [e.x, e.y],
      box: null,
    };
  },
  move(e) {
    if (drag?.type !== type) return;
    update([e.x, e.y], e, !!dragged(drag.gesture, e));
    e.redraw();
  },
  keyChange(mods, redraw) {
    if (drag?.type !== type) return;
    update(drag.at, mods, drag.box !== null);
    redraw();
  },
  up(e) {
    if (drag?.type !== type) return;
    update([e.x, e.y], e, !!dragged(drag.gesture, e));
    const { box } = drag;
    drag = null;
    // One dragged back to a line or a point would be invisible.
    if (box && box.width > 0 && box.height > 0) finish(box);
    e.redraw();
  },
  cancel(redraw) {
    drag = null;
    redraw();
  },
  draw(ctx, _doc, scale) {
    const { pen, fillStroke } = useStore.getState();
    if (drag?.type === type && drag.box) {
      drawDrawing(ctx, outline(drag.box), fillStroke, scale);
    } else if (pen?.shape?.type === type) {
      drawDrawing(ctx, outline(pen.shape), fillStroke, scale);
    }
  },
});

export const rectangleTool = shapeTool("rect", {
  title: "Rectangle Tool",
  shortcut: "M",
  icon: "M2.5 3.5 H13.5 V12.5 H2.5 Z",
});

export const ellipseTool = shapeTool("ellipse", {
  title: "Ellipse Tool",
  shortcut: "L",
  icon: "M2 8 A6 4.5 0 1 0 14 8 A6 4.5 0 1 0 2 8 Z",
});
