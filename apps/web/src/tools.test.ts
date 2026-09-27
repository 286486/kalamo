import { createDocument } from "@zibel/core";
import { beforeEach, expect, it } from "vitest";
import { DEFAULT_FILL_STROKE, useStore } from "./store.ts";
import { fillStrokeKey, finishPen, penClick, penNode, setTool, undoAnchor } from "./tools.ts";

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
  expect(pen()).toEqual({ points: [[50, 50]], closed: false, commandId: null });
});

it("builds the create input from the path, the current fillStroke and placeParent's Layer", () => {
  const s = { doc, selection: [], fillStroke: DEFAULT_FILL_STROKE };
  expect(
    penNode(s, {
      points: [
        [0, 0],
        [10, 0],
        [5, 8],
      ],
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
  penClick([0.5, 0.5], 1); // Not closing: a path needs two Anchors first.
  penClick([10, 0], 1);
  penClick([0.5, -0.5], 1);
  expect(pen()).toMatchObject({
    points: [
      [0, 0],
      [0.5, 0.5],
      [10, 0],
    ],
    closed: true,
  });
  expect(pen()?.commandId).not.toBeNull();
});

it("Ctrl+Z removes the last Anchor and sends nothing", () => {
  penClick([0, 0], 1);
  penClick([10, 0], 1);
  expect(undoAnchor()).toBe(true);
  expect(pen()).toEqual({ points: [[0, 0]], closed: false, commandId: null });
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
