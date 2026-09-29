import { createDocument, createNodes, Shape, shapeSegments } from "@zibel/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dragBox,
  dragRadial,
  ellipseTool,
  polygonTool,
  radiusKey,
  rectangleTool,
  roundedRectangleTool,
  sidesKey,
  uprightAngle,
} from "./shapeTool.ts";
import { send, useStore } from "./store.ts";
import type { CanvasTool, ToolEvent } from "./toolbox.ts";

vi.mock("./store.ts", async (original) => ({
  ...(await original<typeof import("./store.ts")>()),
  send: vi.fn(() => "sent"),
}));

type Point = [number, number];
const NONE = { shift: false, alt: false, space: false };

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
      const { radius, angle } = dragRadial([0, 0], [...p], { shift }, n);
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
    expect(dragRadial(press, [10, 30], NONE, 6)).toEqual({ cx: 10, cy: 20, radius: 10, angle: 30 });
    // Clockwise on screen: from straight down to the left is a quarter turn.
    expect(dragRadial(press, [0, 20], NONE, 6).angle).toBeCloseTo(120, 9);
    expect(dragRadial(press, [20, 20], NONE, 6).angle).toBeCloseTo(300, 9);
    expect(dragRadial(press, [10, 10], NONE, 5).angle).toBeCloseTo(180, 9);
    expect(dragRadial(press, [20, 30], { shift: true }, 5)).toMatchObject({ angle: 0 });
  });
});

it("sidesKey adds and removes a side with Up and Down, within 3…1000", () => {
  expect(sidesKey(6, "ArrowUp")).toBe(7);
  expect(sidesKey(6, "ArrowDown")).toBe(5);
  expect(sidesKey(3, "ArrowDown")).toBe(3);
  expect(sidesKey(1000, "ArrowUp")).toBe(1000);
  expect(sidesKey(6, "ArrowLeft")).toBeNull();
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
