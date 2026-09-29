import { createDocument, createNodes, Shape, shapeSegments } from "@zibel/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countKey,
  dragBox,
  dragLine,
  dragRadial,
  dragStar,
  ellipseTool,
  lineTool,
  polygonTool,
  radiusKey,
  rectangleTool,
  roundedRectangleTool,
  shouldersRatio,
  starTool,
  uprightAngle,
} from "./shapeTool.ts";
import { send, useStore } from "./store.ts";
import type { CanvasTool, ToolEvent } from "./toolbox.ts";

vi.mock("./store.ts", async (original) => ({
  ...(await original<typeof import("./store.ts")>()),
  send: vi.fn(() => "sent"),
}));

type Point = [number, number];
const NONE = { shift: false, alt: false, ctrl: false, space: false };

describe("dragBox", () => {
  const press: Point = [10, 10];
  it.each([
    ["down right", [16, 14], { x: 10, y: 10, width: 6, height: 4 }],
    ["down left", [4, 14], { x: 4, y: 10, width: 6, height: 4 }],
    ["up right", [16, 6], { x: 10, y: 6, width: 6, height: 4 }],
    ["up left", [4, 6], { x: 4, y: 6, width: 6, height: 4 }],
  ] as const)("spans the press and the pointer, dragged %s", (_, p, box) => {
    expect(dragBox(press, [...p], NONE)).toEqual(box);
  });

  it.each([
    [[16, 14], { x: 10, y: 10, width: 6, height: 6 }],
    [[4, 6], { x: 4, y: 4, width: 6, height: 6 }],
    [[12, 2], { x: 10, y: 2, width: 8, height: 8 }],
    [[8, 17], { x: 3, y: 10, width: 7, height: 7 }],
  ] as const)("Shift makes a square as big as the longer side, toward %j", (p, box) => {
    expect(dragBox(press, [...p], { ...NONE, shift: true })).toEqual(box);
  });

  it("Alt centres it on the press, in any direction", () => {
    const box = { x: 4, y: 6, width: 12, height: 8 };
    expect(dragBox(press, [16, 14], { ...NONE, alt: true })).toEqual(box);
    expect(dragBox(press, [4, 6], { ...NONE, alt: true })).toEqual(box);
    expect(dragBox(press, [16, 6], { ...NONE, alt: true })).toEqual(box);
    expect(dragBox(press, [4, 14], { ...NONE, alt: true })).toEqual(box);
  });

  it("Shift and Alt make a square centred on the press", () => {
    const box = { x: 4, y: 4, width: 12, height: 12 };
    expect(dragBox(press, [16, 12], { ...NONE, shift: true, alt: true })).toEqual(box);
    expect(dragBox(press, [8, 4], { ...NONE, shift: true, alt: true })).toEqual(box);
    expect(dragBox(press, [16, 8], { ...NONE, shift: true, alt: true })).toEqual(box);
    expect(dragBox(press, [8, 16], { ...NONE, shift: true, alt: true })).toEqual(box);
  });
});

describe("radiusKey", () => {
  const box = { width: 30, height: 10 };
  it("steps 1 pt from the radius drawn, down to 0", () => {
    expect(radiusKey(3, "ArrowUp", box)).toBe(4);
    expect(radiusKey(3, "ArrowDown", box)).toBe(2);
    expect(radiusKey(0.5, "ArrowDown", box)).toBe(0);
    // 12 draws as 5 in a box 10 high.
    expect(radiusKey(12, "ArrowUp", box)).toBe(6);
    expect(radiusKey(12, "ArrowDown", box)).toBe(4);
    expect(radiusKey(12, "ArrowDown", null)).toBe(11);
  });

  it("Left squares the corners, Right rounds them fully, and other keys are not its", () => {
    expect(radiusKey(3, "ArrowLeft", box)).toBe(0);
    expect(radiusKey(3, "ArrowRight", box)).toBe(Number.POSITIVE_INFINITY);
    expect(radiusKey(3, "C", box)).toBeNull();
    expect(radiusKey(3, "Shift", box)).toBeNull();
  });
});

const { doc, defaultLayerId } = createDocument({
  id: "d",
  name: "Doc",
  artboards: [{ width: 100, height: 100 }],
});

/** A pointer event at `p` in a view at scale 1. */
const at = (p: Point, mods: Partial<typeof NONE> = {}) =>
  ({
    x: p[0],
    y: p[1],
    points: [p],
    ...NONE,
    ctrl: false,
    ...mods,
    clicks: 1,
    doc: useStore.getState().doc,
    viewport: { x: 0, y: 0, scale: 1 },
    capture() {},
    redraw() {},
  }) as unknown as ToolEvent;
/** A press at `from` dragged through `to`, each with its modifiers, then released at the last. */
function dragWith(tool: CanvasTool, from: Point, ...to: [Point, Partial<typeof NONE>?][]) {
  tool.down(at(from));
  for (const [p, mods] of to) tool.move?.(at(p, mods));
  const [p, mods] = to.at(-1) ?? [from];
  tool.up?.(at(p, mods));
}
const sent = () => vi.mocked(send).mock.lastCall?.[0];

beforeEach(() => {
  useStore.setState({
    doc,
    selection: [],
    isolated: null,
    pen: null,
    pending: [],
    notice: null,
    fillStroke: { fill: "#FF0000", stroke: null, active: "fill" },
  });
  vi.mocked(send).mockClear();
});

it.each([
  ["rect", rectangleTool],
  ["ellipse", ellipseTool],
] as const)("a drag sends one %s create in the current Fill and Stroke", (type, tool) => {
  dragWith(tool, [30, 40], [[20, 25]], [[10, 20]]);
  expect(vi.mocked(send)).toHaveBeenCalledTimes(1);
  expect(sent()).toEqual({
    type: "create",
    nodes: [
      {
        type,
        parentId: defaultLayerId,
        x: 10,
        y: 20,
        width: 20,
        height: 20,
        appearance: { fills: [{ color: "#FF0000" }], strokes: [] },
      },
    ],
  });
  // Drawn until its Transaction arrives, which selects it (receive.ts).
  expect(useStore.getState().pending).toMatchObject([{ commandId: "sent", nodes: [{ type }] }]);
});

it("sends nothing for a drag under SLOP", () => {
  dragWith(rectangleTool, [30, 40], [[31, 41]]);
  expect(send).not.toHaveBeenCalled();
  expect(useStore.getState().pending).toEqual([]);
});

it("Space moves the shape, and sizing resumes from the moved origin", () => {
  const space = { space: true };
  dragWith(rectangleTool, [0, 0], [[10, 10]], [[15, 20], space], [[25, 30], space], [[30, 30]]);
  expect(sent()).toMatchObject({ nodes: [{ x: 15, y: 20, width: 15, height: 10 }] });
});

it("previews Shift and Alt pressed or released without a move", () => {
  const rects: string[] = [];
  vi.stubGlobal(
    "Path2D",
    class {
      constructor(d: string) {
        rects.push(d);
      }
    },
  );
  const ctx = { fill() {}, stroke() {} } as unknown as CanvasRenderingContext2D;
  const tool = rectangleTool;
  const preview = () => {
    tool.draw?.(ctx, doc, 1);
    return rects.at(-1);
  };
  tool.down(at([10, 10]));
  tool.move?.(at([16, 14]));
  expect(preview()).toBe("M 10 10 L 16 10 L 16 14 L 10 14 Z");
  tool.keyChange?.({ ...NONE, key: "Shift", down: true, shift: true, alt: true }, () => {});
  expect(preview()).toBe("M 4 4 L 16 4 L 16 16 L 4 16 Z");
  tool.keyChange?.({ ...NONE, key: "Alt", down: false }, () => {});
  expect(preview()).toBe("M 10 10 L 16 10 L 16 14 L 10 14 Z");
  tool.cancel?.(() => {});
  vi.unstubAllGlobals();
});

it("sends nothing for a drag back to a line or a point", () => {
  dragWith(rectangleTool, [30, 40], [[40, 50]], [[50, 40]]);
  dragWith(ellipseTool, [30, 40], [[40, 50]], [[30, 40], { alt: true }]);
  expect(send).not.toHaveBeenCalled();
});

it("draws nothing into a hidden or locked Layer, and says why", () => {
  const layer = doc.nodes.get(defaultLayerId);
  if (!layer) throw new Error("no Layer");
  const nodes = new Map(doc.nodes).set(defaultLayerId, { ...layer, visible: false });
  useStore.setState({ doc: { ...doc, nodes } });
  dragWith(ellipseTool, [0, 0], [[20, 20]]);
  expect(send).not.toHaveBeenCalled();
  expect(useStore.getState()).toMatchObject({ pending: [], notice: /hidden or locked/ });
});

it("draws nothing into a locked Layer from an isolated leaf, leaving the Isolation and Selection", () => {
  const d = structuredClone(doc);
  const { keyMap } = createNodes(d, [
    { type: "rect", clientKey: "leaf", parentId: defaultLayerId, x: 0, y: 0, width: 5, height: 5 },
  ]);
  const layer = d.nodes.get(defaultLayerId);
  if (!layer) throw new Error("no Layer");
  d.nodes.set(defaultLayerId, { ...layer, locked: true });
  const view = { isolated: keyMap.leaf as string, selection: [keyMap.leaf as string] };
  useStore.setState({ doc: d, ...view });
  dragWith(rectangleTool, [0, 0], [[20, 20]]);
  expect(send).not.toHaveBeenCalled();
  expect(useStore.getState()).toMatchObject({ ...view, pending: [], notice: /hidden or locked/ });
});

describe("the Rounded Rectangle tool", () => {
  const key = (k: string, down = true) =>
    roundedRectangleTool.keyChange?.({ ...NONE, key: k, down }, () => {});
  const created = () => {
    const command = sent();
    return command?.type === "create" ? command.nodes[0] : null;
  };

  // In order: the radius each drag leaves is the next one's.
  it("starts at 12 pt, the arrow keys change it, and the last one carries over", () => {
    dragWith(roundedRectangleTool, [0, 0], [[40, 30]]);
    expect(created()).toMatchObject({ type: "rect", width: 40, height: 30, radius: 12 });

    roundedRectangleTool.down(at([0, 0]));
    roundedRectangleTool.move?.(at([40, 30]));
    expect([key("ArrowUp"), key("ArrowUp"), key("ArrowUp", false), key("ArrowDown")]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    roundedRectangleTool.up?.(at([40, 30]));
    expect(created()).toMatchObject({ radius: 13 });

    dragWith(roundedRectangleTool, [0, 0], [[20, 20]]);
    expect(created()).toMatchObject({ radius: 10 });
    dragWith(roundedRectangleTool, [0, 0], [[40, 40]]);
    expect(created()).toMatchObject({ radius: 13 });
  });

  it("Right rounds fully as the box grows, and keeps the radius it drew; Left squares", () => {
    roundedRectangleTool.down(at([0, 0]));
    roundedRectangleTool.move?.(at([10, 10]));
    key("ArrowRight");
    roundedRectangleTool.up?.(at([60, 50]));
    expect(created()).toMatchObject({ width: 60, height: 50, radius: 25 });
    dragWith(roundedRectangleTool, [0, 0], [[80, 80]]);
    expect(created()).toMatchObject({ radius: 25 });

    roundedRectangleTool.down(at([0, 0]));
    key("ArrowLeft");
    roundedRectangleTool.up?.(at([30, 30]));
    expect(created()).toMatchObject({ radius: 0 });
    // A press that draws nothing keeps its radius too, but not Right's, which drew none.
    roundedRectangleTool.down(at([0, 0]));
    key("ArrowUp");
    roundedRectangleTool.up?.(at([1, 1]));
    roundedRectangleTool.down(at([0, 0]));
    key("ArrowRight");
    roundedRectangleTool.up?.(at([1, 1]));
    dragWith(roundedRectangleTool, [0, 0], [[30, 30]]);
    expect(created()).toMatchObject({ radius: 1 });
  });

  it("previews the radius drawn, and takes no key but the arrows", () => {
    const paths: string[] = [];
    vi.stubGlobal(
      "Path2D",
      class {
        constructor(d: string) {
          paths.push(d);
        }
      },
    );
    const ctx = { fill() {}, stroke() {} } as unknown as CanvasRenderingContext2D;
    roundedRectangleTool.down(at([0, 0]));
    roundedRectangleTool.move?.(at([20, 10]));
    key("ArrowLeft");
    roundedRectangleTool.draw?.(ctx, doc, 1);
    expect(paths.at(-1)).toBe("M 0 0 L 20 0 L 20 10 L 0 10 Z");
    key("ArrowUp");
    key("ArrowUp");
    roundedRectangleTool.draw?.(ctx, doc, 1);
    expect(paths.at(-1)).toMatch(/^M 2 0 L 18 0 C/);
    expect([key("C"), key("M"), key("Shift")]).toEqual([false, false, false]);
    // The Rectangle tool takes no key, and is not drawing this one.
    expect(rectangleTool.keyChange?.({ ...NONE, key: "ArrowUp", down: true }, () => {})).toBe(
      false,
    );
    rectangleTool.draw?.(ctx, doc, 1);
    expect(paths).toHaveLength(2);
    roundedRectangleTool.cancel?.(() => {});
    vi.unstubAllGlobals();
  });
});

describe("dragRadial", () => {
  /** The polygon's vertices, as core draws them. */
  const vertices = (sides: number, angle: number) =>
    shapeSegments(Shape.parse({ type: "polygon", cx: 0, cy: 0, radius: 10, sides, angle }))
      .filter((s) => s.cmd !== "Z")
      .map((s) => s.args as Point);
  /** Its lowest edge: the two vertices with the greatest y. */
  const bottom = (v: Point[]) => [...v].sort((a, b) => b[1] - a[1]).slice(0, 2);

  it.each([3, 4, 5, 6, 7, 8])("a %i-gon dragged straight down, or with Shift, sits flat", (n) => {
    for (const [p, shift] of [
      [[0, 10], false],
      [[7, -3], true],
    ] as const) {
      const { radius, angle } = dragRadial([0, 0], [...p], { shift }, uprightAngle(n));
      const [a, b] = bottom(vertices(n, angle));
      expect(a?.[1]).toBeCloseTo(b?.[1] ?? Number.NaN, 9);
      expect(radius).toBeCloseTo(Math.hypot(...p), 9);
    }
  });

  it("points a triangle up and turns an even count half a step", () => {
    expect([3, 4, 5, 6].map(uprightAngle)).toEqual([0, 45, 0, 30]);
    const [top] = [...vertices(3, 0)].sort((a, b) => a[1] - b[1]);
    expect(top?.[0]).toBeCloseTo(0, 9);
  });

  it("centres on the press, and turns with the pointer's direction", () => {
    const press: Point = [10, 20];
    expect(dragRadial(press, [10, 30], NONE, uprightAngle(6))).toEqual({
      cx: 10,
      cy: 20,
      radius: 10,
      angle: 30,
    });
    // Clockwise on screen: from straight down to the left is a quarter turn.
    expect(dragRadial(press, [0, 20], NONE, uprightAngle(6)).angle).toBeCloseTo(120, 9);
    expect(dragRadial(press, [20, 20], NONE, uprightAngle(6)).angle).toBeCloseTo(300, 9);
    expect(dragRadial(press, [10, 10], NONE, uprightAngle(5)).angle).toBeCloseTo(180, 9);
    expect(dragRadial(press, [20, 30], { shift: true }, uprightAngle(5))).toMatchObject({
      angle: 0,
    });
  });
});

it("countKey adds and removes one with Up and Down, within 3…1000", () => {
  expect(countKey(6, "ArrowUp")).toBe(7);
  expect(countKey(6, "ArrowDown")).toBe(5);
  expect(countKey(3, "ArrowDown")).toBe(3);
  expect(countKey(1000, "ArrowUp")).toBe(1000);
  expect(countKey(6, "ArrowLeft")).toBeNull();
});

describe("the Polygon tool", () => {
  const key = (k: string, down = true, mods: Partial<typeof NONE> = {}) =>
    polygonTool.keyChange?.({ ...NONE, ...mods, key: k, down }, () => {});
  const created = () => {
    const command = sent();
    return command?.type === "create" ? command.nodes[0] : null;
  };

  // In order: the side count each drag leaves is the next one's.
  it("draws 6 sides from its centre, Up and Down change them, and the count carries over", () => {
    dragWith(polygonTool, [30, 40], [[30, 50]], [[30, 60]]);
    expect(vi.mocked(send)).toHaveBeenCalledTimes(1);
    expect(created()).toEqual({
      type: "polygon",
      parentId: defaultLayerId,
      cx: 30,
      cy: 40,
      radius: 20,
      sides: 6,
      angle: 30,
      appearance: { fills: [{ color: "#FF0000" }], strokes: [] },
    });

    polygonTool.down(at([0, 0]));
    polygonTool.move?.(at([0, 20]));
    expect([key("ArrowUp"), key("ArrowUp"), key("ArrowUp", false), key("ArrowDown")]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(key("C")).toBe(false);
    polygonTool.up?.(at([0, 20]));
    expect(created()).toMatchObject({ sides: 7, angle: 0 });
    dragWith(polygonTool, [0, 0], [[0, 20]]);
    expect(created()).toMatchObject({ sides: 7 });

    // Clamped to 3, and kept by a press that draws nothing.
    polygonTool.down(at([0, 0]));
    for (let i = 0; i < 10; i++) key("ArrowDown");
    polygonTool.up?.(at([1, 1]));
    dragWith(polygonTool, [0, 0], [[0, 20]]);
    expect(created()).toMatchObject({ sides: 3 });
    polygonTool.down(at([0, 0]));
    key("ArrowUp");
    key("ArrowUp");
    key("ArrowUp");
    polygonTool.up?.(at([0, 20]));
    expect(created()).toMatchObject({ sides: 6 });
  });

  it("turns with the drag, Shift keeps it upright, Alt changes nothing, and Space moves it", () => {
    dragWith(polygonTool, [0, 0], [[-20, 0]]);
    expect(created()).toMatchObject({ cx: 0, cy: 0, radius: 20, angle: 120 });
    dragWith(polygonTool, [0, 0], [[-20, 0], { shift: true }]);
    expect(created()).toMatchObject({ radius: 20, angle: 30 });
    dragWith(polygonTool, [0, 0], [[-20, 0], { alt: true }]);
    expect(created()).toMatchObject({ cx: 0, cy: 0, radius: 20, angle: 120 });
    const space = { space: true };
    dragWith(polygonTool, [0, 0], [[0, 10]], [[5, 15], space], [[5, 25], space], [[5, 30]]);
    expect(created()).toMatchObject({ cx: 5, cy: 15, radius: 15, angle: 30 });
  });

  it("previews the side count and Shift without a move, and sends nothing dragged back to its centre", () => {
    const paths: string[] = [];
    vi.stubGlobal(
      "Path2D",
      class {
        constructor(d: string) {
          paths.push(d);
        }
      },
    );
    const ctx = { fill() {}, stroke() {} } as unknown as CanvasRenderingContext2D;
    const corners = () => {
      polygonTool.draw?.(ctx, doc, 1);
      return paths.at(-1)?.match(/[ML]/g)?.length;
    };
    polygonTool.down(at([0, 0]));
    polygonTool.move?.(at([20, 0]));
    expect(corners()).toBe(6);
    key("ArrowDown");
    expect(corners()).toBe(5);
    const turned = paths.at(-1);
    key("Shift", true, { shift: true });
    expect(corners()).toBe(5);
    expect(paths.at(-1)).not.toBe(turned);
    key("ArrowUp");
    polygonTool.up?.(at([0, 0]));
    expect(send).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("dragStar", () => {
  const star = { points: 5, ratio: 0.5, inner: null };
  /** The star's vertices, outer first, as core draws them. */
  const vertices = (points: number, innerRadius: number) =>
    shapeSegments(Shape.parse({ type: "star", cx: 0, cy: 0, outerRadius: 10, innerRadius, points }))
      .filter((s) => s.cmd !== "Z")
      .map((s) => s.args as Point);

  it.each([5, 6])("a %i-point star dragged straight down, or with Shift, points up", (points) => {
    expect(dragStar([10, 20], [10, 40], NONE, { ...star, points })).toEqual({
      type: "star",
      cx: 10,
      cy: 20,
      outerRadius: 20,
      innerRadius: 10,
      points,
      angle: 0,
    });
    const shifted = dragStar([10, 20], [30, 5], { ...NONE, shift: true }, { ...star, points });
    expect(shifted).toMatchObject({ outerRadius: 25, innerRadius: 12.5, angle: 0 });
  });

  it("turns with the drag, and Ctrl's held inner radius overrides the ratio", () => {
    expect(dragStar([0, 0], [-20, 0], NONE, star).angle).toBeCloseTo(90, 9);
    expect(dragStar([0, 0], [0, 30], NONE, { ...star, inner: 4 })).toMatchObject({
      outerRadius: 30,
      innerRadius: 4,
    });
  });

  it.each([5, 6, 8])("Alt straightens a %i-point star's shoulders", (points) => {
    const { innerRadius, outerRadius } = dragStar(
      [0, 0],
      [0, 10],
      { ...NONE, alt: true },
      {
        ...star,
        inner: 4,
        points,
      },
    );
    expect(innerRadius / outerRadius).toBeCloseTo(shouldersRatio(points) ?? Number.NaN, 12);
    // Outer 0, inner 0, inner 1 and outer 2 lie on one line.
    const [p0, q0, , q1, p2] = vertices(points, innerRadius) as [Point, Point, Point, Point, Point];
    const cross = (a: Point, b: Point) =>
      (b[0] - p0[0]) * (a[1] - p0[1]) - (b[1] - p0[1]) * (a[0] - p0[0]);
    for (const v of [q0, q1]) expect(cross(v, p2)).toBeCloseTo(0, 9);
  });

  it.each([3, 4])("Alt does nothing to a %i-point star", (points) => {
    expect(shouldersRatio(points)).toBeNull();
    const plain = dragStar([0, 0], [0, 10], NONE, { ...star, points });
    expect(dragStar([0, 0], [0, 10], { ...NONE, alt: true }, { ...star, points })).toEqual(plain);
  });
});

it.each([
  ["Polygon", polygonTool, "sides"],
  ["Star", starTool, "points"],
] as const)("the %s tool's Up stops at 1000 and Down at 3", (_, tool, count) => {
  const press = (k: string, times: number) => {
    tool.down(at([0, 0]));
    for (let i = 0; i < times; i++) tool.keyChange?.({ ...NONE, key: k, down: true }, () => {});
    tool.up?.(at([0, 20]));
    return (sent() as { nodes: Record<string, unknown>[] }).nodes[0]?.[count];
  };
  expect(press("ArrowUp", 1000)).toBe(1000);
  expect(press("ArrowUp", 1)).toBe(1000);
  expect(press("ArrowDown", 1000)).toBe(3);
  expect(press("ArrowDown", 1)).toBe(3);
  // Back to the tools' defaults for the tests after.
  press("ArrowUp", count === "sides" ? 3 : 2);
});

describe("the Star tool", () => {
  const key = (k: string, down = true, mods: Partial<typeof NONE> = {}) =>
    starTool.keyChange?.({ ...NONE, ...mods, key: k, down }, () => {});
  const created = () => {
    const command = sent();
    return command?.type === "create" ? command.nodes[0] : null;
  };

  // In order: the point count and ratio each drag leaves are the next one's.
  it("draws 5 points at half the radius, and Up and Down change the count, which carries over", () => {
    dragWith(starTool, [30, 40], [[30, 50]], [[30, 60]]);
    expect(vi.mocked(send)).toHaveBeenCalledTimes(1);
    expect(created()).toEqual({
      type: "star",
      parentId: defaultLayerId,
      cx: 30,
      cy: 40,
      outerRadius: 20,
      innerRadius: 10,
      points: 5,
      angle: 0,
      appearance: { fills: [{ color: "#FF0000" }], strokes: [] },
    });

    starTool.down(at([0, 0]));
    starTool.move?.(at([0, 20]));
    expect([key("ArrowUp"), key("ArrowUp"), key("ArrowDown"), key("C")]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    starTool.up?.(at([0, 20]));
    expect(created()).toMatchObject({ points: 6, angle: 0 });
    dragWith(starTool, [0, 0], [[0, 20]]);
    expect(created()).toMatchObject({ points: 6 });

    // Clamped to 3, and kept by a press that draws nothing.
    starTool.down(at([0, 0]));
    for (let i = 0; i < 10; i++) key("ArrowDown");
    starTool.up?.(at([1, 1]));
    dragWith(starTool, [0, 0], [[0, 20]]);
    expect(created()).toMatchObject({ points: 3 });
    for (let i = 0; i < 2; i++) {
      starTool.down(at([0, 0]));
      key("ArrowUp");
      starTool.up?.(at([0, 20]));
    }
    expect(created()).toMatchObject({ points: 5 });
  });

  it("Ctrl holds the inner radius as the pointer moves, and its ratio holds once released", () => {
    const ctrl = { ctrl: true };
    starTool.down(at([0, 0]));
    starTool.move?.(at([0, 20]));
    key("Control", true, ctrl);
    starTool.move?.(at([0, 40], ctrl));
    starTool.move?.(at([0, 50], ctrl));
    key("Control", false);
    // 10 of 50: a ratio of 0.2 from here on.
    starTool.move?.(at([0, 30]));
    starTool.up?.(at([0, 30]));
    expect(created()).toMatchObject({ outerRadius: 30, innerRadius: 6 });
    dragWith(starTool, [0, 0], [[0, 10]]);
    expect(created()).toMatchObject({ outerRadius: 10, innerRadius: 2 });
    // Ctrl read from the move alone, held to the release.
    dragWith(starTool, [0, 0], [[0, 20]], [[0, 20], ctrl], [[0, 80], ctrl]);
    expect(created()).toMatchObject({ outerRadius: 80, innerRadius: 4 });
    dragWith(starTool, [0, 0], [[0, 10]]);
    expect(created()).toMatchObject({ outerRadius: 10, innerRadius: 0.5 });
  });

  it("Shift keeps it upright, Alt straightens its shoulders, and Space moves it", () => {
    dragWith(starTool, [0, 0], [[-20, 0], { shift: true }]);
    const { angle, outerRadius } = created() as { angle: number; outerRadius: number };
    expect([angle, outerRadius]).toEqual([0, 20]);
    dragWith(starTool, [0, 0], [[0, 20], { alt: true }]);
    expect(created()).toMatchObject({ innerRadius: 20 * (shouldersRatio(5) ?? 0) });
    const space = { space: true };
    dragWith(starTool, [0, 0], [[0, 10]], [[5, 15], space], [[5, 25], space], [[5, 30]]);
    expect(created()).toMatchObject({ cx: 5, cy: 15, outerRadius: 15, angle: 0 });
  });

  it("sends nothing dragged back to its centre", () => {
    dragWith(starTool, [0, 0], [[20, 0]], [[0, 0]]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("dragLine", () => {
  const press: Point = [10, 20];
  it("runs from the press to the pointer", () => {
    expect(dragLine(press, [40, -5], NONE)).toEqual({
      type: "line",
      x1: 10,
      y1: 20,
      x2: 40,
      y2: -5,
    });
  });

  it.each([
    [
      [40, 22],
      [40, 20],
    ],
    [
      [31, -2],
      [31.5, -1.5],
    ],
    [
      [12, 60],
      [10, 60],
    ],
    [
      [-20, 49],
      [-19.5, 49.5],
    ],
  ] as const)("Shift turns the line toward %j to a multiple of 45°", (p, end) => {
    const { x2, y2 } = dragLine(press, [...p], { ...NONE, shift: true });
    expect([x2, y2]).toEqual(end);
  });

  it("Alt makes the press its midpoint, with Shift too", () => {
    expect(dragLine(press, [40, 30], { ...NONE, alt: true })).toEqual({
      type: "line",
      x1: -20,
      y1: 10,
      x2: 40,
      y2: 30,
    });
    expect(dragLine(press, [40, 22], { ...NONE, shift: true, alt: true })).toEqual({
      type: "line",
      x1: -20,
      y1: 20,
      x2: 40,
      y2: 20,
    });
  });
});

describe("the Line Segment tool", () => {
  const created = () => {
    const command = sent();
    return command?.type === "create" ? command.nodes[0] : null;
  };

  it("draws a line in the current Stroke and no Fill, even with the Fill box set", () => {
    useStore.setState({ fillStroke: { fill: "#FF0000", stroke: "#0000FF", active: "fill" } });
    dragWith(lineTool, [30, 40], [[50, 45]], [[70, 60]]);
    expect(vi.mocked(send)).toHaveBeenCalledTimes(1);
    expect(created()).toEqual({
      type: "line",
      parentId: defaultLayerId,
      x1: 30,
      y1: 40,
      x2: 70,
      y2: 60,
      appearance: { fills: [], strokes: [{ color: "#0000FF", width: 1 }] },
    });
    expect(useStore.getState().pending).toMatchObject([{ nodes: [{ type: "line" }] }]);
  });

  it("with a None Stroke is still drawn, unpainted", () => {
    dragWith(lineTool, [0, 0], [[20, 10]]);
    expect(created()).toMatchObject({ type: "line", appearance: { fills: [], strokes: [] } });
  });

  it("Shift gives 45°, Alt centres it on the press, and Space moves it", () => {
    dragWith(lineTool, [0, 0], [[30, 28], { shift: true }]);
    expect(created()).toMatchObject({ x1: 0, y1: 0, x2: 29, y2: 29 });
    dragWith(lineTool, [0, 0], [[30, 10], { alt: true }]);
    expect(created()).toMatchObject({ x1: -30, y1: -10, x2: 30, y2: 10 });
    const space = { space: true };
    dragWith(lineTool, [0, 0], [[10, 10]], [[15, 20], space], [[25, 30], space], [[30, 30]]);
    expect(created()).toMatchObject({ x1: 15, y1: 20, x2: 30, y2: 30 });
  });

  it("previews unfilled, Shift without a move, and sends nothing dragged back to zero length", () => {
    const drawn: string[] = [];
    vi.stubGlobal(
      "Path2D",
      class {
        constructor(d: string) {
          drawn.push(d);
        }
      },
    );
    const ctx = {
      fill: () => drawn.push("fill"),
      stroke() {},
    } as unknown as CanvasRenderingContext2D;
    lineTool.down(at([0, 0]));
    lineTool.move?.(at([20, 18]));
    lineTool.draw?.(ctx, doc, 1);
    expect(drawn).toEqual(["M 0 0 L 20 18"]);
    lineTool.keyChange?.({ ...NONE, key: "Shift", down: true, shift: true }, () => {});
    lineTool.draw?.(ctx, doc, 1);
    expect(drawn.at(-1)).toBe("M 0 0 L 19 19");
    lineTool.up?.(at([0, 0]));
    expect(send).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
