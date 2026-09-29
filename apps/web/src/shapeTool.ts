import { dragged, drawDrawing, type Press, shapePath } from "./canvas.ts";
import type { ShapeBox } from "./receive.ts";
import { useStore } from "./store.ts";
import type { CanvasTool, KeyMods } from "./toolbox.ts";
import { sendNewArt } from "./tools.ts";

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
 * The Rounded Rectangle tool's corner radius, kept for the next drag in the session as
 * Illustrator's Preferences > General > Corner Radius is. Its 12 pt default is Illustrator's, not
 * checked in a live Illustrator (research 06, open question 7).
 */
let cornerRadius = 12;

/**
 * The corner radius after `key` while dragging `box`, as in Illustrator, or null for another key.
 * Up and Down step 1 pt from the radius drawn, down to 0, so each press shows; Left squares the
 * corners and Right rounds them fully, as big as the box grows.
 */
export function radiusKey(
  radius: number,
  key: string,
  box: Pick<ShapeBox, "width" | "height"> | null,
): number | null {
  const drawn = box ? Math.min(radius, box.width / 2, box.height / 2) : radius;
  switch (key) {
    case "ArrowUp":
      return drawn + 1;
    case "ArrowDown":
      return Math.max(0, drawn - 1);
    case "ArrowLeft":
      return 0;
    case "ArrowRight":
      return Number.POSITIVE_INFINITY;
    default:
      return null;
  }
}

/**
 * A drag draws a Live Shape of `type`, previewed in the current Fill and Stroke until release. A
 * rounded one's arrow keys change its corner radius.
 */
const shapeTool = (
  type: ShapeBox["type"],
  tool: Pick<CanvasTool, "title" | "shortcut" | "icon" | "group">,
  rounded = false,
): CanvasTool => {
  /**
   * The drag under way: where it started, moved by Space, the pointer, the corner radius, and the
   * modifiers, re-read on every move and key. `box` is null until the drag passes SLOP.
   */
  let drag: {
    gesture: Press;
    origin: Point;
    at: Point;
    radius: number;
    box: ShapeBox | null;
  } | null = null;

  function update(p: Point, mods: KeyMods, moved: boolean) {
    if (!drag) return;
    // Space moves the whole shape: the origin follows the pointer, and sizing resumes from there.
    if (mods.space)
      drag.origin = [drag.origin[0] + p[0] - drag.at[0], drag.origin[1] + p[1] - drag.at[1]];
    drag.at = p;
    if (!moved) return;
    const box = dragBox(drag.origin, p, mods);
    // The radius drawn, which core would clamp to anyway, is the one sent.
    const radius = Math.min(drag.radius, box.width / 2, box.height / 2);
    drag.box = { type, ...box, ...(rounded && { radius }) };
  }

  return {
    ...tool,
    cursor: "crosshair",
    down(e) {
      e.capture();
      drag = {
        gesture: { start: { x: e.x, y: e.y }, moved: false },
        origin: [e.x, e.y],
        at: [e.x, e.y],
        radius: cornerRadius,
        box: null,
      };
    },
    move(e) {
      if (!drag) return;
      update([e.x, e.y], e, !!dragged(drag.gesture, e));
      e.redraw();
    },
    keyChange(key, redraw) {
      if (!drag) return false;
      const radius = rounded ? radiusKey(drag.radius, key.key, drag.box) : null;
      if (radius !== null && key.down) drag.radius = radius;
      update(drag.at, key, drag.box !== null);
      redraw();
      return radius !== null;
    },
    up(e) {
      if (!drag) return;
      update([e.x, e.y], e, !!dragged(drag.gesture, e));
      const { box, radius } = drag;
      drag = null;
      if (rounded && Number.isFinite(radius)) cornerRadius = radius;
      // One dragged back to a line or a point would be invisible.
      if (!box || box.width === 0 || box.height === 0) return e.redraw();
      // Right's fully rounded corners are kept as the radius they drew.
      if (rounded && !Number.isFinite(radius)) cornerRadius = box.radius ?? 0;
      sendNewArt([box]);
      e.redraw();
    },
    cancel(redraw) {
      drag = null;
      redraw();
    },
    draw(ctx, _doc, scale) {
      const path = drag?.box && shapePath(drag.box);
      if (path) drawDrawing(ctx, path, useStore.getState().fillStroke, scale);
    },
  };
};

export const rectangleTool = shapeTool("rect", {
  title: "Rectangle Tool",
  shortcut: "M",
  group: "rectangle",
  icon: "M2.5 3.5 H13.5 V12.5 H2.5 Z",
});

export const roundedRectangleTool = shapeTool(
  "rect",
  {
    title: "Rounded Rectangle Tool",
    shortcut: "",
    group: "rectangle",
    icon: "M5.5 3.5 H10.5 A3 3 0 0 1 13.5 6.5 V9.5 A3 3 0 0 1 10.5 12.5 H5.5 A3 3 0 0 1 2.5 9.5 V6.5 A3 3 0 0 1 5.5 3.5 Z",
  },
  true,
);

export const ellipseTool = shapeTool("ellipse", {
  title: "Ellipse Tool",
  shortcut: "L",
  group: "rectangle",
  icon: "M2 8 A6 4.5 0 1 0 14 8 A6 4.5 0 1 0 2 8 Z",
});
