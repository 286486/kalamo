import {
  createDocument,
  createNodes,
  editPath,
  type Node,
  parsePath,
  toAnchors,
} from "@zibel/core";
import { expect, it } from "vitest";
import {
  anchorKey,
  clearInputs,
  deleteAnchors,
  marqueeAnchors,
  moveAnchors,
  moveHandle,
  moveSegment,
  pick,
  splitWhole,
} from "./direct.ts";

/** A 10 pt square rect at (0, 0), a curve moved by (100, 0), and a hidden line. */
function fixture() {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const [rect, curve, hidden] = createNodes(doc, [
    { type: "rect", parentId, x: 0, y: 0, width: 10, height: 10 },
    { type: "path", parentId, d: "M 0 0 C 0 10 20 10 20 0 C 20 -10 40 -10 40 0" },
    { type: "path", parentId, d: "M 0 50 L 10 50" },
  ] as never).nodes as [Node, Node, Node];
  doc.nodes.set(curve.id, { ...curve, transform: [1, 0, 0, 1, 100, 0] });
  doc.nodes.set(hidden.id, { ...hidden, visible: false });
  return { doc, rect, curve: doc.nodes.get(curve.id) as Node };
}

const dOf = (n: Node) => ("d" in n ? n.d : "");

it("picks a selected Anchor's Handle first, then an Anchor, then a segment within the tolerance", () => {
  const { doc, rect, curve } = fixture();
  const middle = anchorKey(curve.id, 0, 1);
  // The middle Anchor sits at (120, 0), its Handles at (120, 10) and (120, -10).
  expect(pick(doc, [curve.id], [middle], 120, 9, 2)).toEqual({
    kind: "handle",
    key: middle,
    which: "handleIn",
  });
  expect(pick(doc, [], [], 120, 9, 2)).toBeNull();
  expect(pick(doc, [], [], 10.5, 0.5, 2)).toEqual({
    kind: "anchor",
    key: anchorKey(rect.id, 0, 1),
  });
  expect(pick(doc, [], [], 5, 1, 2)).toMatchObject({
    kind: "segment",
    nodeId: rect.id,
    subpath: 0,
    segment: 0,
    t: expect.closeTo(0.5, 1),
  });
  // A hidden path is not hit.
  expect(pick(doc, [], [], 0, 50, 2)).toBeNull();
});

it("a marquee takes the Anchors inside it across paths, skipping hidden ones", () => {
  const { doc, rect, curve } = fixture();
  expect(marqueeAnchors(doc, { x: 5, y: -5, width: 100, height: 60 })).toEqual([
    anchorKey(rect.id, 0, 1),
    anchorKey(rect.id, 0, 2),
    anchorKey(curve.id, 0, 0),
  ]);
});

it("moving Anchors makes one path_edit per path, in each path's own coordinates", () => {
  const { doc, rect, curve } = fixture();
  const inputs = moveAnchors(doc, [anchorKey(rect.id, 0, 2), anchorKey(curve.id, 0, 0)], 5, 1);
  expect(inputs).toEqual([
    { nodeId: rect.id, ops: [{ op: "move_anchor", subpath: 0, index: 2, to: [15, 11] }] },
    { nodeId: curve.id, ops: [{ op: "move_anchor", subpath: 0, index: 0, to: [5, 1] }] },
  ]);
  // The rect becomes a path, keeping its id.
  const input = inputs[0];
  if (!input) throw new Error("no input");
  const { node } = editPath(doc, input);
  expect(node).toMatchObject({ id: rect.id, type: "path", d: "M 0 0 L 10 0 L 15 11 L 0 10 Z" });
});

it("a Smooth Anchor's other Handle turns with the dragged one; Alt leaves it, and the Anchor Corner", () => {
  const { doc, curve } = fixture();
  const middle = anchorKey(curve.id, 0, 1);
  // Drag handleOut from (20, -10) to (30, 0) in the path's coordinates.
  const turned = moveHandle(doc, middle, "handleOut", 10, 10, false);
  expect(turned).toEqual({
    nodeId: curve.id,
    ops: [
      {
        op: "set_handles",
        subpath: 0,
        index: 1,
        handleOut: [30, 0],
        handleIn: [expect.closeTo(10), expect.closeTo(0)],
      },
    ],
  });
  const alone = moveHandle(doc, middle, "handleOut", 10, 10, true);
  if (!alone) throw new Error("no input");
  const { subpaths } = editPath(doc, alone);
  expect(subpaths[0]?.anchors[1]).toMatchObject({ handleIn: [20, 10], type: "corner" });
});

it("a straight segment moves both its Anchors; a curved one bends through its Handles", () => {
  const { doc, rect, curve } = fixture();
  expect(moveSegment(doc, rect.id, 0, 3, 0.5, -2, 0)).toEqual({
    nodeId: rect.id,
    ops: [
      { op: "move_anchor", subpath: 0, index: 3, to: [-2, 10] },
      { op: "move_anchor", subpath: 0, index: 0, to: [-2, 0] },
    ],
  });
  const bent = moveSegment(doc, curve.id, 0, 0, 0.5, 0, 4);
  if (!bent) throw new Error("no input");
  const { node } = editPath(doc, bent);
  // The grabbed middle, at (10, 7.5), follows the pointer to (10, 11.5).
  const [, c] = parsePath(dOf(node), "d");
  const [x1, y1, x2, y2] = c?.args ?? [];
  expect(0.125 * 0 + 0.375 * (x1 ?? 0) + 0.375 * (x2 ?? 0) + 0.125 * 20).toBeCloseTo(10);
  expect(0.375 * (y1 ?? 0) + 0.375 * (y2 ?? 0)).toBeCloseTo(11.5);
});

it("Delete removes Anchors and their segments, opening the path there", () => {
  const closed = toAnchors(parsePath("M 0 0 L 10 0 L 10 10 L 0 10 Z", "d"));
  expect(deleteAnchors(closed, [{ subpath: 0, index: 1 }])).toMatchObject([
    { closed: false, anchors: [{ anchor: [10, 10] }, { anchor: [0, 10] }, { anchor: [0, 0] }] },
  ]);
  // An interior Anchor of an open path leaves two pieces; a piece of one Anchor goes.
  const open = toAnchors(parsePath("M 0 0 L 10 0 L 20 0 L 30 0 L 40 0", "d"));
  expect(deleteAnchors(open, [{ subpath: 0, index: 2 }])).toMatchObject([
    { anchors: [{ anchor: [0, 0] }, { anchor: [10, 0] }] },
    { anchors: [{ anchor: [30, 0] }, { anchor: [40, 0] }] },
  ]);
  expect(
    deleteAnchors(open, [
      { subpath: 0, index: 1 },
      { subpath: 0, index: 3 },
    ]),
  ).toEqual([]);
});

it("Clear deletes selected Anchors, and whole the selected objects without any", () => {
  const { doc, rect, curve } = fixture();
  const other = createNodes(doc, [
    { type: "rect", parentId: rect.parentId, x: 0, y: 0, width: 1, height: 1 },
  ] as never).nodes[0] as Node;
  const selection = [rect.id, curve.id, other.id];
  // An Anchor out of range, as after someone else's edit, is ignored: no set_d converts the rect.
  expect(clearInputs(doc, selection, [anchorKey(rect.id, 0, 9)])).toEqual({
    edits: [],
    deleteIds: [curve.id, other.id],
  });
  expect(clearInputs(doc, selection, [anchorKey(rect.id, 0, 1)])).toEqual({
    edits: [{ nodeId: rect.id, ops: [{ op: "set_d", d: "M 10 10 L 0 10 L 0 0" }] }],
    deleteIds: [curve.id, other.id],
  });
  // Every Anchor of the curve leaves nothing: the curve goes.
  const all = [0, 1, 2].map((i) => anchorKey(curve.id, 0, i));
  expect(clearInputs(doc, [curve.id], all)).toEqual({ edits: [], deleteIds: [curve.id] });
});

it("a path with every Anchor selected moves whole; a partly selected one by its Anchors", () => {
  const { doc, rect, curve } = fixture();
  const keys = [0, 1, 2, 3].map((i) => anchorKey(rect.id, 0, i));
  expect(splitWhole(doc, [...keys, anchorKey(curve.id, 0, 1)])).toEqual({
    whole: [rect.id],
    partial: [anchorKey(curve.id, 0, 1)],
  });
});
