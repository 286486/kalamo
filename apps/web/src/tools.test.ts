import { type BareAnchor, createDocument, parsePath, toAnchors } from "@zibel/core";
import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_FILL_STROKE, send, useStore } from "./store.ts";
import {
  fillStrokeKey,
  finishPen,
  penDown,
  penDrag,
  penNode,
  penUp,
  setTool,
  undoAnchor,
} from "./tools.ts";

vi.mock("./store.ts", async (original) => ({
  ...(await original<typeof import("./store.ts")>()),
  send: vi.fn(() => "sent"),
}));

type Point = [number, number];
const penClick = (p: Point, tolerance: number, shift = false) => {
  penDown(p, tolerance, shift);
  penUp();
};
const NONE = { shift: false, alt: false, ctrl: false, space: false };
/** A press at `from` dragged through `to`, each with its modifiers, then released. */
const penDragged = (from: Point, ...to: [Point, Partial<typeof NONE>?][]) => {
  penDown(from, 1);
  for (const [p, mods] of to) penDrag(p, { ...NONE, ...mods });
  penUp();
};
const corner = (x: number, y: number): BareAnchor => ({
  anchor: [x, y],
  handleIn: null,
  handleOut: null,
});
const anchors = () => useStore.getState().pen?.anchors;
/** The type core derives for an Anchor but the last, whose outgoing Handle `d` leaves out. */
const typeAt = (i: number) => {
  const pen = useStore.getState().pen;
  if (!pen) throw new Error("no path");
  const node = penNode({ doc, selection: [], fillStroke: DEFAULT_FILL_STROKE }, pen);
  if (node?.type !== "path") throw new Error("no path");
  return toAnchors(parsePath(node.d, "d"))[0]?.anchors[i]?.type;
};

const { doc, defaultLayerId } = createDocument({
  id: "d",
  name: "Doc",
  artboards: [{ width: 100, height: 100 }],
});

beforeEach(() => {
  useStore.setState({
    doc,
    selection: [],
    pen: null,
    tool: "pen",
    fillStroke: DEFAULT_FILL_STROKE,
  });
  vi.mocked(send).mockClear();
});

const pen = () => useStore.getState().pen;

it("D resets, X toggles the active box, Shift+X swaps and / sets the active box to None", () => {
  const p = { fill: "#FF0000", stroke: null, active: "stroke" as const };
  expect(fillStrokeKey(p, "D")).toEqual({ fill: "#FFFFFF", stroke: "#000000", active: "stroke" });
  expect(fillStrokeKey(p, "X")).toEqual({ ...p, active: "fill" });
  expect(fillStrokeKey(p, "Shift+X")).toEqual({ ...p, fill: null, stroke: "#FF0000" });
  expect(fillStrokeKey(DEFAULT_FILL_STROKE, "/")).toEqual({ ...DEFAULT_FILL_STROKE, fill: null });
  expect(fillStrokeKey(p, "Q")).toBeNull();
});

it("Enter sends three Corner Anchors as one open path with the current Fill and Stroke", () => {
  useStore.setState({ fillStroke: { fill: null, stroke: "#FF0000", active: "fill" } });
  for (const p of [
    [0, 0],
    [10, 0],
    [5, 8],
  ] as [number, number][])
    penClick(p, 1);
  finishPen();
  expect(pen()).toMatchObject({ closed: false, commandId: expect.any(String) });
  // The next click starts another path; the sent one waits for its answer in receive.
  penClick([50, 50], 1);
  expect(pen()).toEqual({ anchors: [corner(50, 50)], closed: false, commandId: null });
});

it("builds the create input from the path, the current fillStroke and placeParent's Layer", () => {
  const s = { doc, selection: [], fillStroke: DEFAULT_FILL_STROKE };
  expect(
    penNode(s, {
      anchors: [corner(0, 0), corner(10, 0), corner(5, 8)],
      closed: true,
      commandId: null,
    }),
  ).toEqual({
    type: "path",
    parentId: defaultLayerId,
    d: "M 0 0 L 10 0 L 5 8 Z",
    appearance: {
      fills: [{ color: "#FFFFFF" }],
      strokes: [{ color: "#000000", width: 1 }],
    },
  });
});

it("a click on the first Anchor closes the path", () => {
  penClick([0, 0], 1);
  penClick([2, 2], 1); // Not closing: a path needs two Anchors first.
  penClick([10, 0], 1);
  penClick([0.5, -0.5], 1);
  expect(pen()).toMatchObject({
    anchors: [corner(0, 0), corner(2, 2), corner(10, 0)],
    closed: true,
  });
  expect(pen()?.commandId).not.toBeNull();
});

it("Ctrl+Z removes the last Anchor and sends nothing", () => {
  penClick([0, 0], 1);
  penClick([10, 0], 1);
  expect(undoAnchor()).toBe(true);
  expect(pen()).toEqual({ anchors: [corner(0, 0)], closed: false, commandId: null });
  expect(undoAnchor()).toBe(true);
  expect(pen()).toBeNull();
  expect(undoAnchor()).toBe(false);
});

it("a tool switch finishes the path, and a single Anchor is dropped", () => {
  penClick([0, 0], 1);
  penClick([10, 0], 1);
  setTool("selection");
  expect(pen()?.commandId).not.toBeNull();
  expect(useStore.getState().tool).toBe("selection");
  useStore.setState({ pen: null });
  penClick([0, 0], 1);
  finishPen();
  expect(pen()).toBeNull();
});

it("draws nothing into a hidden or locked Layer, and says why", () => {
  const layer = doc.nodes.get(defaultLayerId);
  if (!layer) throw new Error("no Layer");
  const nodes = new Map(doc.nodes).set(defaultLayerId, { ...layer, locked: true });
  useStore.setState({ doc: { ...doc, nodes }, notice: null });
  penClick([0, 0], 1);
  penClick([10, 0], 1);
  finishPen();
  expect(pen()).toBeNull();
  expect(useStore.getState().notice).toMatch(/locked/);
});

it("Shift-click constrains the segment to a multiple of 45°", () => {
  penClick([0, 0], 1);
  penClick([10, 9], 1, true);
  expect(anchors()?.[1]?.anchor).toEqual([9.5, 9.5]);
});

it("a drag places a Smooth Anchor whose Handles mirror each other", () => {
  penClick([0, 0], 1);
  penDragged([10, 0], [[15, 5]]);
  expect(anchors()?.[1]).toEqual({ anchor: [10, 0], handleIn: [5, -5], handleOut: [15, 5] });
  penClick([40, 40], 1);
  expect(typeAt(1)).toBe("smooth");
});

it("Alt while dragging leaves the incoming Handle behind: a Corner (cusp)", () => {
  penClick([0, 0], 1);
  // Released before the button, as Illustrator documents it, Alt leaves the Handles broken.
  penDragged([10, 0], [[15, 5]], [[10, 10], { alt: true }], [[10, 12]]);
  expect(anchors()?.[1]).toEqual({ anchor: [10, 0], handleIn: [5, -5], handleOut: [10, 12] });
  penClick([40, 40], 1);
  expect(typeAt(1)).toBe("corner");
});

it("Ctrl while dragging keeps the Handles collinear and the incoming one's length", () => {
  penClick([0, 0], 1);
  penDragged([10, 0], [[15, 0]], [[30, 0], { ctrl: true }]);
  expect(anchors()?.[1]).toEqual({ anchor: [10, 0], handleIn: [5, 0], handleOut: [30, 0] });
  penClick([40, 40], 1);
  expect(typeAt(1)).toBe("smooth");
});

it("Shift while dragging constrains the Handle to a multiple of 45°", () => {
  penDragged([0, 0], [[10, 1], { shift: true }]);
  expect(anchors()?.[0]).toEqual({ anchor: [0, 0], handleIn: [-10, 0], handleOut: [10, 0] });
});

it("Space while the button is down moves the Anchor with its Handles", () => {
  penClick([0, 0], 1);
  penDragged([10, 0], [[15, 5]], [[20, 5], { space: true }], [[25, 5]]);
  expect(anchors()?.[1]).toEqual({ anchor: [15, 0], handleIn: [5, -5], handleOut: [25, 5] });
});

it("a click on the last Anchor removes its outgoing Handle, and a drag pulls a new one", () => {
  penClick([0, 0], 1);
  penDragged([10, 0], [[15, 5]]);
  penClick([10, 0], 1);
  expect(anchors()).toEqual([corner(0, 0), { ...corner(10, 0), handleIn: [5, -5] }]);
  penDragged([10, 0], [[10, 10]]);
  expect(anchors()?.[1]).toEqual({ anchor: [10, 0], handleIn: [5, -5], handleOut: [10, 10] });
});

it("closing on the first Anchor with a drag shapes the closing segment", () => {
  penClick([0, 0], 1);
  penClick([10, 0], 1);
  penClick([5, 8], 1);
  penDown([0, 0], 1);
  penDrag([-5, 5], NONE);
  expect(pen()?.commandId).toBeNull();
  penUp();
  expect(pen()).toMatchObject({
    anchors: [{ anchor: [0, 0], handleIn: [5, -5], handleOut: [-5, 5] }, {}, {}],
    closed: true,
    commandId: "sent",
  });
});

it("Alt while closing keeps the first segment and shapes only the closing one", () => {
  penDragged([0, 0], [[5, -5]]);
  penClick([10, 0], 1);
  penDragged([0, 0], [[-5, 0], { alt: true }]);
  expect(anchors()?.[0]).toEqual({ anchor: [0, 0], handleIn: [5, 0], handleOut: [5, -5] });
});

it("a path of Smooth Anchors commits as C segments in one Transaction", () => {
  penDragged([0, 0], [[5, -5]]);
  penDragged([20, 0], [[25, 5]]);
  penDragged([40, 0], [[45, -5]]);
  finishPen();
  expect(send).toHaveBeenCalledTimes(1);
  expect(vi.mocked(send).mock.calls[0]?.[0]).toMatchObject({
    type: "create",
    nodes: [{ d: "M 0 0 C 5 -5 15 -5 20 0 C 25 5 35 5 40 0" }],
  });
});
