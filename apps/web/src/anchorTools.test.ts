import {
  createDocument,
  createNodes,
  type Document,
  editPath,
  parsePath,
  toAnchors,
} from "@zibel/core";
import { beforeEach, expect, it, vi } from "vitest";
import { addAnchorTool, anchorPointTool, deleteAnchorTool } from "./anchorTools.ts";
import { nearestSegment } from "./direct.ts";
import { penTool } from "./penTool.ts";
import { send, useStore } from "./store.ts";
import type { CanvasTool, ToolEvent } from "./toolbox.ts";

vi.mock("./store.ts", async (original) => ({
  ...(await original<typeof import("./store.ts")>()),
  send: vi.fn(() => "sent"),
}));

/** An Agent's path: a Smooth Anchor at (10, 0) between two Corners. */
function agentPath() {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 100, height: 100 }],
  });
  const [path] = createNodes(doc, [
    { type: "path", parentId, d: "M 0 0 C 0 0 5 -5 10 0 C 15 5 20 0 20 0" },
  ]).nodes;
  useStore.setState({ doc, selection: [], anchors: [], segments: [], edit: null });
  return { doc, id: path?.id as string };
}

/** An Agent's 40 by 20 Rectangle at (0, 0), a Live Shape. */
function agentRect() {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 100, height: 100 }],
  });
  createNodes(doc, [{ type: "rect", parentId, x: 0, y: 0, width: 40, height: 20 }]);
  useStore.setState({ doc, selection: [], anchors: [], segments: [], edit: null });
  return doc;
}

const event = (doc: Document, x: number, y: number, alt = false, shift = false): ToolEvent =>
  ({
    x,
    y,
    points: [[x, y]],
    shift,
    alt,
    ctrl: false,
    space: false,
    doc,
    viewport: { x: 0, y: 0, scale: 1 },
    capture() {},
    redraw() {},
  }) as unknown as ToolEvent;

/** A press at `from`, dragged through `to`, then released. */
function gesture(
  tool: CanvasTool,
  doc: Document,
  from: [number, number],
  ...to: [number, number][]
) {
  tool.down(event(doc, ...from));
  for (const p of to) tool.move?.(event(doc, ...p));
  tool.up?.(event(doc, ...(to.at(-1) ?? from)));
}

/** The path's d after the one path_edit sent, and the warnings it gave. */
function editedPath(doc: Document) {
  const calls = vi.mocked(send).mock.calls.map(([c]) => c);
  expect(calls).toHaveLength(1);
  const [c] = calls;
  if (c?.type !== "path_edit") throw new Error(`sent ${c?.type}`);
  const after = { ...doc, nodes: new Map(doc.nodes) };
  const { node, warnings } = editPath(after, c.input);
  return { d: node.d, warnings };
}

/** The path's Anchors after the one path_edit sent. */
const edited = (doc: Document) => toAnchors(parsePath(editedPath(doc).d, "d"))[0]?.anchors ?? [];

beforeEach(() => vi.mocked(send).mockClear());

it("+ adds an Anchor where a segment is clicked, and Alt deletes instead", () => {
  const { doc } = agentPath();
  gesture(addAnchorTool, doc, [15, 2.5]);
  const anchors = edited(doc);
  expect(anchors).toHaveLength(4);
  expect(anchors[2]?.anchor[0]).toBeCloseTo(15, 0);
  vi.mocked(send).mockClear();
  addAnchorTool.down(event(doc, 10, 0, true));
  expect(edited(doc)).toHaveLength(2);
});

it("- removes the Anchor clicked, keeping the path connected", () => {
  const { doc } = agentPath();
  gesture(deleteAnchorTool, doc, [10, 0]);
  expect(edited(doc).map((a) => a.anchor)).toEqual([
    [0, 0],
    [20, 0],
  ]);
});

it("Shift+C: a click makes a Smooth Anchor Corner", () => {
  const { doc } = agentPath();
  gesture(anchorPointTool, doc, [10, 0]);
  expect(edited(doc)[1]).toMatchObject({ type: "corner", handleIn: null, handleOut: null });
});

it("Shift+C: dragging out of a Corner pulls out mirrored Handles, making it Smooth", () => {
  const { doc } = agentPath();
  gesture(anchorPointTool, doc, [20, 0], [25, 5]);
  // An Endpoint has only its incoming Handle, which follows the drag.
  expect(edited(doc)[2]).toMatchObject({ handleIn: [25, 5], handleOut: null });
});

it("Shift+C: dragging a Handle of a selected Anchor moves it alone, making a Corner", () => {
  const { doc, id } = agentPath();
  useStore.setState({ selection: [id], anchors: [`${id} 0 1`] });
  gesture(anchorPointTool, doc, [15, 5], [15, 10]);
  expect(edited(doc)[1]).toMatchObject({ type: "corner", handleIn: [5, -5], handleOut: [15, 10] });
});

it("Shift+C: dragging a Live Shape's straight segment pulls out Handles through the pointer", () => {
  const doc = agentRect();
  gesture(anchorPointTool, doc, [20, 0], [20, -10]);
  const { d, warnings } = editedPath(doc);
  expect(warnings).toMatchObject([{ code: "CONVERTED_TO_PATH" }]);
  const [s] = toAnchors(parsePath(d, "d"));
  expect(s?.anchors[0]?.handleOut).not.toBeNull();
  expect(s?.anchors[1]?.handleIn).not.toBeNull();
  expect(nearestSegment(s ? [s] : [], 20, -10)?.dist).toBeCloseTo(0, 1);
});

it("Shift+C: dragging a curved segment bends it through the pointer", () => {
  const { doc } = agentPath();
  // The first segment's middle is at (3.125, -1.875).
  gesture(anchorPointTool, doc, [3.125, -1.875], [5, 6]);
  const anchors = edited(doc);
  expect(nearestSegment([{ anchors, closed: false }], 5, 6)).toMatchObject({ segment: 0 });
  expect(nearestSegment([{ anchors, closed: false }], 5, 6)?.dist).toBeCloseTo(0, 1);
  expect(anchors[1]?.handleOut).toEqual([15, 5]);
});

it("Shift+C: Shift bends a segment into a semicircle on the pointer's side", () => {
  const doc = agentRect();
  anchorPointTool.down(event(doc, 20, 0));
  anchorPointTool.move?.(event(doc, 20, -15, false, true));
  anchorPointTool.up?.(event(doc, 20, -15, false, true));
  const [a, b] = edited(doc);
  expect(a?.handleOut?.[0]).toBeCloseTo(0);
  expect(b?.handleIn?.[0]).toBeCloseTo(40);
  // Handles 4/3 of the radius long, perpendicular to the segment.
  expect(a?.handleOut?.[1]).toBeCloseTo(-80 / 3);
  expect(b?.handleIn?.[1]).toBeCloseTo(-80 / 3);
});

it("Shift+C: a click on a Handle's end retracts it alone; both retracted leave a line", () => {
  const { doc, id } = agentPath();
  useStore.setState({ selection: [id], anchors: [`${id} 0 1`] });
  gesture(anchorPointTool, doc, [15, 5]);
  const anchors = edited(doc);
  expect(anchors[1]).toMatchObject({ handleIn: [5, -5], handleOut: null });
  expect(anchors[0]?.handleOut).toBeNull();
  // The second segment's far Handle sits on its Anchor, so it is straight now.
  expect(editedPath(doc).d).toBe("M 0 0 C 0 0 5 -5 10 0 L 20 0");
});

it("Alt with the Pen bends a segment when not drawing", () => {
  const { doc } = agentPath();
  penTool.down(event(doc, 3.125, -1.875, true));
  penTool.move?.(event(doc, 5, 6, true));
  penTool.up?.(event(doc, 5, 6, true));
  const anchors = edited(doc);
  expect(nearestSegment([{ anchors, closed: false }], 5, 6)?.dist).toBeCloseTo(0, 1);
});
