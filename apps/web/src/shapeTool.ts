import { formatPath, MAX_COUNT, MIN_COUNT, parsePath, pathBounds } from "@zibel/core";
import { dragged, drawDrawing, type Press, shapePath } from "./canvas.ts";
import type { ShapeBox } from "./receive.ts";
import { useStore } from "./store.ts";
import type { CanvasTool, KeyMods } from "./toolbox.ts";
import {
  constrain,
  type LineArt,
  type NewArt,
  type PathArt,
  type StarArt,
  sendNewArt,
} from "./tools.ts";

type Point = [number, number];

/** The drag from `press` to `p`, made as long in x as in y with Shift, by its longer side. */
function dragSize(press: Point, p: Point, shift: boolean): Point {
  const [dx, dy] = [p[0] - press[0], p[1] - press[1]];
  if (!shift) return [dx, dy];
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return [dx < 0 ? -side : side, dy < 0 ? -side : side];
}

/**
 * The box a drag from `press` to `p` draws (F-DRAW-01): Shift makes it a square, as big as the
 * drag's longer side, and Alt centres it on `press`. A drag in any direction gives a positive size.
 */
export function dragBox(
  press: Point,
  p: Point,
  { shift, alt }: Pick<KeyMods, "shift" | "alt">,
): Omit<ShapeBox, "type"> {
  const [dx, dy] = dragSize(press, p, shift);
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
 * The line a drag from `press` to `p` draws (F-DRAW-01), as Illustrator's Line Segment tool does:
 * from the press to the pointer. Shift turns it to a multiple of 45°, and Alt makes the press its
 * midpoint.
 */
export function dragLine(
  press: Point,
  p: Point,
  { shift, alt }: Pick<KeyMods, "shift" | "alt">,
): LineArt {
  const [x2, y2] = shift ? constrain(press, p) : p;
  const [x1, y1] = alt ? [2 * press[0] - x2, 2 * press[1] - y2] : press;
  return { type: "line", x1, y1, x2, y2 };
}

/** The Arc tool's options (ADR-0059): open or closed, its base axis, and its slope, −100…100. */
export interface ArcOption {
  closed: boolean;
  axis: "x" | "y";
  slope: number;
}

/**
 * The arc a drag from `press` to `p` draws (ADR-0059), as Illustrator's Arc tool does: from the
 * press to the pointer, bent around the box corner the base axis picks by one cubic whose handles
 * reach `|slope|`% of the way to the far corner (convex) or to that corner (concave). Closed, it
 * runs back through that corner. Shift makes Length X equal Length Y, and Alt centres it on `press`.
 */
export function dragArc(
  press: Point,
  p: Point,
  { shift, alt }: Pick<KeyMods, "shift" | "alt">,
  { closed, axis, slope }: ArcOption,
): PathArt {
  const [dx, dy] = dragSize(press, p, shift);
  const b: Point = [press[0] + dx, press[1] + dy];
  const a: Point = alt ? [press[0] - dx, press[1] - dy] : press;
  const corner: Point = axis === "x" ? [b[0], a[1]] : [a[0], b[1]];
  const far: Point = [a[0] + b[0] - corner[0], a[1] + b[1] - corner[1]];
  const target = slope > 0 ? far : corner;
  const t = Math.abs(slope) / 100;
  const toward = (q: Point) => [q[0] + t * (target[0] - q[0]), q[1] + t * (target[1] - q[1])];
  return {
    type: "path",
    d: formatPath([
      { cmd: "M", args: a },
      { cmd: "C", args: [...toward(a), ...toward(b), ...b] },
      ...(closed
        ? [
            { cmd: "L" as const, args: corner },
            { cmd: "Z" as const, args: [] },
          ]
        : []),
    ]),
  };
}

/**
 * The Arc tool's options after `key` during a drag (ADR-0059), or null for another key: Up and Down
 * step the slope, C opens or closes the arc, F flips it to the other base axis, and X switches
 * concave and convex.
 */
export function arcKey(arc: ArcOption, key: string): ArcOption | null {
  switch (key) {
    case "ArrowUp":
      return { ...arc, slope: Math.min(100, arc.slope + 1) };
    case "ArrowDown":
      return { ...arc, slope: Math.max(-100, arc.slope - 1) };
    case "C":
      return { ...arc, closed: !arc.closed };
    case "F":
      return { ...arc, axis: arc.axis === "x" ? "y" : "x" };
    case "X":
      return { ...arc, slope: -arc.slope };
    default:
      return null;
  }
}

/**
 * The `angle` (ADR-0024) at which a polygon of `sides` sits upright, its bottom edge horizontal:
 * 0 for an odd count, whose first vertex points up, and half a step for an even one.
 */
export const uprightAngle = (sides: number) => (sides % 2 ? 0 : 180 / sides);

/**
 * The centre, radius and angle a drag from `press` to `p` draws (F-DRAW-01), as Illustrator's
 * Polygon tool does; the Star and Spiral tools share it. The press is the centre and the pointer
 * sets the radius. Its direction turns the shape from `upright`, the angle it has for a drag
 * straight down, and Shift keeps it upright.
 */
export function dragRadial(
  press: Point,
  p: Point,
  { shift }: Pick<KeyMods, "shift">,
  upright: number,
): { cx: number; cy: number; radius: number; angle: number } {
  const [dx, dy] = [p[0] - press[0], p[1] - press[1]];
  // Degrees clockwise on screen from straight down.
  const turn = shift ? 0 : (Math.atan2(-dx, dy) * 180) / Math.PI;
  const angle = (((upright + turn) % 360) + 360) % 360;
  return { cx: press[0], cy: press[1], radius: Math.hypot(dx, dy), angle };
}

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
 * A polygon's side count or a star's point count after `key`, as in Illustrator: Up adds one and
 * Down removes one, within core's bounds.
 */
export function countKey(count: number, key: string): number | null {
  if (key === "ArrowUp") return Math.min(MAX_COUNT, count + 1);
  if (key === "ArrowDown") return Math.max(MIN_COUNT, count - 1);
  return null;
}

/**
 * The inner radius, as a fraction of the outer, at which a star of `points` has straight shoulders
 * (Illustrator's Alt): each point's edges lie on the lines joining every second point, as in a
 * pentagram. Null for 3 and 4 points, which have no such star.
 */
export const shouldersRatio = (points: number) =>
  points < 5 ? null : Math.cos((2 * Math.PI) / points) / Math.cos(Math.PI / points);

/**
 * The Star tool's option: its point count, the inner radius as a fraction of the outer, and the
 * inner radius Ctrl holds, or null.
 */
export interface StarOption {
  points: number;
  ratio: number;
  inner: number | null;
}

/**
 * The star a drag from `press` to `p` draws (F-DRAW-01), as Illustrator's Star tool does: the
 * pointer's distance from the press is the outer radius, and the drag turns it as `dragRadial`
 * does, from pointing straight up. The inner radius is Ctrl's held one or else `ratio` of the
 * outer; Alt straightens the shoulders instead, where `points` allows it.
 */
export function dragStar(
  press: Point,
  p: Point,
  mods: Pick<KeyMods, "shift" | "alt">,
  { points, ratio, inner }: StarOption,
): StarArt {
  const { cx, cy, radius, angle } = dragRadial(press, p, mods, 0);
  const shoulders = mods.alt ? shouldersRatio(points) : null;
  const innerRadius = shoulders === null ? (inner ?? ratio * radius) : shoulders * radius;
  return { type: "star", cx, cy, outerRadius: radius, innerRadius, points, angle };
}

/** `star` once Ctrl is up: the inner radius it held, if any, becomes the ratio drawn. */
const unhold = (star: StarOption, art: StarArt | null): StarOption => ({
  ...star,
  ratio:
    star.inner !== null && art && art.outerRadius > 0 ? star.inner / art.outerRadius : star.ratio,
  inner: null,
});

/**
 * What a shape tool's drag draws, and the option (corner radius, side count, a star's radii) its
 * keys and modifiers change.
 */
interface DragShape<A extends NewArt, O> {
  /** The option the session's first drag starts with. */
  option: O;
  art(origin: Point, p: Point, mods: KeyMods, option: O): A;
  /** False for art dragged back to nothing visible: a point, or a box flat as a line. */
  visible(art: A): boolean;
  /** True when painted with the current Stroke and no Fill, whatever the Fill box holds. */
  unfilled?(option: O): boolean;
  /** `option` after `key` while `art` is drawn, or null when the key is not the drag's. */
  key?(option: O, key: string, art: A | null): O | null;
  /** `option` with the modifiers `mods` held, re-read before `art` is redrawn. */
  mods?(option: O, mods: KeyMods, art: A | null): O;
  /**
   * The option the next drag starts from, after one that ended with `option` and drew `art`, or
   * nothing; `kept` is the one it started from. The drag's own by default.
   */
  keep?(option: O, art: A | null, kept: O): O;
}

/**
 * A drag draws a Live Shape, or the Arc tool's Path, previewed in its paint until release. The option
 * each drag ends with carries over to the next one in the session.
 */
function shapeTool<A extends NewArt, O>(
  tool: Pick<CanvasTool, "title" | "shortcut" | "icon" | "group">,
  shape: DragShape<A, O>,
): CanvasTool {
  let kept = shape.option;
  const paint = (option: O) => {
    const { fillStroke } = useStore.getState();
    return shape.unfilled?.(option) ? { ...fillStroke, fill: null } : fillStroke;
  };
  /**
   * The drag under way: where it started, moved by Space, the pointer, the option, and the
   * modifiers, re-read on every move and key. `art` is null until the drag passes SLOP.
   */
  let drag: { gesture: Press; origin: Point; at: Point; option: O; art: A | null } | null = null;

  function update(p: Point, mods: KeyMods, moved: boolean) {
    if (!drag) return;
    // Space moves the whole shape: the origin follows the pointer, and sizing resumes from there.
    if (mods.space)
      drag.origin = [drag.origin[0] + p[0] - drag.at[0], drag.origin[1] + p[1] - drag.at[1]];
    drag.at = p;
    if (shape.mods) drag.option = shape.mods(drag.option, mods, drag.art);
    if (moved) drag.art = shape.art(drag.origin, p, mods, drag.option);
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
        option: kept,
        art: null,
      };
    },
    move(e) {
      if (!drag) return;
      update([e.x, e.y], e, !!dragged(drag.gesture, e));
      e.redraw();
    },
    keyChange(key, redraw) {
      if (!drag) return false;
      const option = shape.key?.(drag.option, key.key, drag.art) ?? null;
      if (option !== null && key.down) drag.option = option;
      update(drag.at, key, drag.art !== null);
      redraw();
      return option !== null;
    },
    up(e) {
      if (!drag) return;
      update([e.x, e.y], e, !!dragged(drag.gesture, e));
      const { art, option } = drag;
      drag = null;
      const shown = art && shape.visible(art) ? art : null;
      kept = shape.keep ? shape.keep(option, shown, kept) : option;
      if (shown) sendNewArt([shown], { fillStroke: paint(option) });
      e.redraw();
    },
    cancel(redraw) {
      drag = null;
      redraw();
    },
    draw(ctx, _doc, scale) {
      const path = drag?.art && shapePath(drag.art);
      if (drag && path) drawDrawing(ctx, path, paint(drag.option), scale);
    },
  };
}

/** A Rectangle or Ellipse spanning the drag. */
const box = (type: ShapeBox["type"]) =>
  ({
    option: null,
    art: (origin, p, mods) => ({ type, ...dragBox(origin, p, mods) }),
    visible: (b) => b.width > 0 && b.height > 0,
  }) satisfies DragShape<ShapeBox, null>;

export const rectangleTool = shapeTool(
  {
    title: "Rectangle Tool",
    shortcut: "M",
    group: "rectangle",
    icon: "M2.5 3.5 H13.5 V12.5 H2.5 Z",
  },
  box("rect"),
);

export const roundedRectangleTool = shapeTool<ShapeBox, number>(
  {
    title: "Rounded Rectangle Tool",
    shortcut: "",
    group: "rectangle",
    icon: "M5.5 3.5 H10.5 A3 3 0 0 1 13.5 6.5 V9.5 A3 3 0 0 1 10.5 12.5 H5.5 A3 3 0 0 1 2.5 9.5 V6.5 A3 3 0 0 1 5.5 3.5 Z",
  },
  {
    ...box("rect"),
    // Kept as Illustrator's Preferences > General > Corner Radius is. Its 12 pt default is
    // Illustrator's, not checked in a live Illustrator (research 06, open question 7).
    option: 12,
    art(origin, p, mods, radius) {
      const b = dragBox(origin, p, mods);
      // The radius drawn, which core would clamp to anyway, is the one sent.
      return { type: "rect", ...b, radius: Math.min(radius, b.width / 2, b.height / 2) };
    },
    key: radiusKey,
    // Right's fully rounded corners are kept as the radius they drew, or not at all if none.
    keep: (radius, b, kept) => (Number.isFinite(radius) ? radius : (b?.radius ?? kept)),
  },
);

export const ellipseTool = shapeTool(
  {
    title: "Ellipse Tool",
    shortcut: "L",
    group: "rectangle",
    icon: "M2 8 A6 4.5 0 1 0 14 8 A6 4.5 0 1 0 2 8 Z",
  },
  box("ellipse"),
);

export const polygonTool = shapeTool(
  {
    title: "Polygon Tool",
    shortcut: "",
    group: "rectangle",
    icon: "M2 8 L5 2.8 H11 L14 8 L11 13.2 H5 Z",
  },
  {
    // Illustrator's default side count.
    option: 6,
    art: (origin, p, mods, sides) => ({
      type: "polygon",
      ...dragRadial(origin, p, mods, uprightAngle(sides)),
      sides,
    }),
    visible: (polygon) => polygon.radius > 0,
    key: countKey,
  },
);

export const starTool = shapeTool<StarArt, StarOption>(
  {
    title: "Star Tool",
    shortcut: "",
    group: "rectangle",
    icon: "M8 1.5 L9.6 5.8 L14.2 6 L10.6 8.9 L11.8 13.3 L8 10.8 L4.2 13.3 L5.4 8.9 L1.8 6 L6.4 5.8 Z",
  },
  {
    // Illustrator's default star: 5 points, radii 50 pt and 25 pt.
    option: { points: 5, ratio: 0.5, inner: null },
    art: dragStar,
    visible: (star) => star.outerRadius > 0,
    key: (star, key) => {
      const points = countKey(star.points, key);
      return points === null ? null : { ...star, points };
    },
    // Ctrl pressed holds the inner radius drawn; released, it leaves the ratio that drew.
    mods(star, { ctrl }, art) {
      if (!ctrl) return unhold(star, art);
      return star.inner === null && art ? { ...star, inner: art.innerRadius } : star;
    },
    keep: unhold,
  },
);

/**
 * Illustrator's Line Segment tool with Fill Line off, its default: the line takes the current
 * Stroke and no Fill. With a None Stroke it is still drawn, unpainted, as the Pen's path is; Adobe
 * does not document that case, so it is unverified. The line is selected, so its outline shows.
 */
export const lineTool = shapeTool(
  { title: "Line Segment Tool", shortcut: "\\", group: "line", icon: "M2.5 13.5 L13.5 2.5" },
  {
    option: null,
    art: dragLine,
    visible: ({ x1, y1, x2, y2 }) => x1 !== x2 || y1 !== y2,
    unfilled: () => true,
  },
);

/**
 * Illustrator's Arc tool with Fill Arc off, its default (ADR-0059): a Path, open in the current
 * Stroke and no Fill, or closed in the current Fill and Stroke. A drag flat as a line still draws
 * it, a straight line, as Illustrator's does.
 */
export const arcTool = shapeTool<PathArt, ArcOption>(
  { title: "Arc Tool", shortcut: "", group: "line", icon: "M2.5 13.5 C2.5 7.5 7.5 2.5 13.5 2.5" },
  {
    option: { closed: false, axis: "x", slope: 50 },
    art: dragArc,
    visible: ({ d }) => {
      const box = pathBounds(parsePath(d, "d"));
      return !!box && (box.width > 0 || box.height > 0);
    },
    key: arcKey,
    unfilled: ({ closed }) => !closed,
  },
);
