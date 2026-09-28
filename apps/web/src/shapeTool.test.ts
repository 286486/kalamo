import { createDocument } from "@zibel/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dragBox, ellipseTool, rectangleTool } from "./shapeTool.ts";
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
  ] as const)("Shift makes a square as big as the longer side, toward %j", (p, box) => {
    expect(dragBox(press, [...p], { ...NONE, shift: true })).toEqual(box);
  });

  it("Alt centres it on the press, in any direction", () => {
    const box = { x: 4, y: 6, width: 12, height: 8 };
    expect(dragBox(press, [16, 14], { ...NONE, alt: true })).toEqual(box);
    expect(dragBox(press, [4, 6], { ...NONE, alt: true })).toEqual(box);
  });

  it("Shift and Alt make a square centred on the press", () => {
    const box = { x: 4, y: 4, width: 12, height: 12 };
    expect(dragBox(press, [16, 12], { ...NONE, shift: true, alt: true })).toEqual(box);
    expect(dragBox(press, [8, 4], { ...NONE, shift: true, alt: true })).toEqual(box);
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
  expect(useStore.getState().pen).toMatchObject({ commandId: "sent", shape: { type } });
});

it("sends nothing for a drag under SLOP", () => {
  dragWith(rectangleTool, [30, 40], [[31, 41]]);
  expect(send).not.toHaveBeenCalled();
  expect(useStore.getState().pen).toBeNull();
});

it("Space moves the shape, and sizing resumes from the moved origin", () => {
  const space = { space: true };
  dragWith(rectangleTool, [0, 0], [[10, 10]], [[15, 20], space], [[25, 30], space], [[30, 30]]);
  expect(sent()).toMatchObject({ nodes: [{ x: 15, y: 20, width: 15, height: 10 }] });
});

it("reads Shift and Alt pressed without a move", () => {
  const tool = rectangleTool;
  tool.down(at([10, 10]));
  tool.move?.(at([16, 14]));
  tool.keyChange?.({ ...NONE, shift: true, alt: true }, () => {});
  tool.up?.(at([16, 14], { shift: true, alt: true }));
  expect(sent()).toMatchObject({ nodes: [{ x: 4, y: 4, width: 12, height: 12 }] });
});

it("draws nothing into a hidden or locked Layer, and says why", () => {
  const layer = doc.nodes.get(defaultLayerId);
  if (!layer) throw new Error("no Layer");
  const nodes = new Map(doc.nodes).set(defaultLayerId, { ...layer, visible: false });
  useStore.setState({ doc: { ...doc, nodes } });
  dragWith(ellipseTool, [0, 0], [[20, 20]]);
  expect(send).not.toHaveBeenCalled();
  expect(useStore.getState()).toMatchObject({ pen: null, notice: /hidden or locked/ });
});
