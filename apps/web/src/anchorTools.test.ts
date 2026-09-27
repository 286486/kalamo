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
  useStore.setState({ doc, selection: [], anchors: [], edit: null });
  return { doc, id: path?.id as string };
}

const event = (doc: Document, x: number, y: number, alt = false): ToolEvent =>
  ({
    x,
    y,
    points: [[x, y]],
    shift: false,
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

/** The path after the one path_edit sent. */
function edited(doc: Document) {
  const calls = vi.mocked(send).mock.calls.map(([c]) => c);
  expect(calls).toHaveLength(1);
  const [c] = calls;
  if (c?.type !== "path_edit") throw new Error(`sent ${c?.type}`);
  const after = { ...doc, nodes: new Map(doc.nodes) };
  return toAnchors(parsePath(editPath(after, c.input).node.d, "d"))[0]?.anchors ?? [];
}

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
