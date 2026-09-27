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
  anchorOpTargets,
  clearInputs,
  deleteParts,
  marqueeAnchors,
  moveAnchors,
  moveHandle,
  moveSegment,
  pick,
  removeAnchorInputs,
  segmentHandles,
  segmentInRange,
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
  expect(deleteParts(closed, [{ subpath: 0, index: 1 }])).toMatchObject([
    { closed: false, anchors: [{ anchor: [10, 10] }, { anchor: [0, 10] }, { anchor: [0, 0] }] },
  ]);
  // An interior Anchor of an open path leaves two pieces; a piece of one Anchor goes.
  const open = toAnchors(parsePath("M 0 0 L 10 0 L 20 0 L 30 0 L 40 0", "d"));
  expect(deleteParts(open, [{ subpath: 0, index: 2 }])).toMatchObject([
    { anchors: [{ anchor: [0, 0] }, { anchor: [10, 0] }] },
    { anchors: [{ anchor: [30, 0] }, { anchor: [40, 0] }] },
  ]);
  expect(
    deleteParts(open, [
      { subpath: 0, index: 1 },
      { subpath: 0, index: 3 },
    ]),
  ).toEqual([]);
});

it("Delete removes segments alone, keeping their Anchors, and mixes with Anchors", () => {
  const seg = (index: number) => ({ subpath: 0, index });
  const open = toAnchors(parsePath("M 0 0 C 0 5 10 5 10 0 L 20 0 L 30 0", "d"));
  // A middle segment splits the subpath in two; the new ends lose the Handle into the gap.
  expect(deleteParts(open, [], [seg(1)])).toEqual([
    {
      closed: false,
      anchors: [
        { anchor: [0, 0], handleIn: null, handleOut: [0, 5], type: "corner" },
        { anchor: [10, 0], handleIn: [10, 5], handleOut: null, type: "corner" },
      ],
    },
    {
      closed: false,
      anchors: [
        { anchor: [20, 0], handleIn: null, handleOut: null, type: "corner" },
        { anchor: [30, 0], handleIn: null, handleOut: null, type: "corner" },
      ],
    },
  ]);
  // An end segment leaves a one-Anchor piece, which goes.
  expect(deleteParts(open, [], [seg(2)])).toMatchObject([
    { anchors: [{ anchor: [0, 0] }, { anchor: [10, 0] }, { anchor: [20, 0] }] },
  ]);
  // A closed subpath opens at the cut, even at its closing segment.
  const square = toAnchors(parsePath("M 0 0 L 10 0 L 10 10 L 0 10 Z", "d"));
  expect(deleteParts(square, [], [seg(1)])).toMatchObject([
    {
      closed: false,
      anchors: [{ anchor: [10, 10] }, { anchor: [0, 10] }, { anchor: [0, 0] }, { anchor: [10, 0] }],
    },
  ]);
  expect(deleteParts(square, [], [seg(3)])).toMatchObject([
    {
      anchors: [{ anchor: [0, 0] }, { anchor: [10, 0] }, { anchor: [10, 10] }, { anchor: [0, 10] }],
    },
  ]);
  // Two segments of the square leave two pieces; an Anchor takes its two segments with it.
  expect(deleteParts(square, [], [seg(0), seg(2)])).toMatchObject([
    { anchors: [{ anchor: [10, 0] }, { anchor: [10, 10] }] },
    { anchors: [{ anchor: [0, 10] }, { anchor: [0, 0] }] },
  ]);
  expect(deleteParts(square, [seg(0)], [seg(2)])).toMatchObject([
    { anchors: [{ anchor: [10, 0] }, { anchor: [10, 10] }] },
  ]);
  expect(deleteParts(square, [seg(0)], [seg(1)])).toMatchObject([
    { anchors: [{ anchor: [10, 10] }, { anchor: [0, 10] }] },
  ]);
  // An open subpath's last Anchor starts no segment.
  expect(deleteParts(open, [], [seg(3)])).toEqual(open);
});

it("Clear deletes selected segments, converting a Live Shape, and ignores out-of-range ones", () => {
  const { doc, rect, curve } = fixture();
  expect(segmentInRange(doc, anchorKey(rect.id, 0, 3))).toBe(true);
  expect(segmentInRange(doc, anchorKey(rect.id, 0, 4))).toBe(false);
  expect(segmentInRange(doc, anchorKey(curve.id, 0, 2))).toBe(false);
  expect(clearInputs(doc, [rect.id], [], [anchorKey(rect.id, 0, 9)])).toEqual({
    edits: [],
    deleteIds: [],
  });
  expect(clearInputs(doc, [rect.id, curve.id], [], [anchorKey(rect.id, 0, 3)])).toEqual({
    edits: [{ nodeId: rect.id, ops: [{ op: "set_d", d: "M 0 0 L 10 0 L 10 10 L 0 10" }] }],
    deleteIds: [curve.id],
  });
  // An Anchor of the curve and a segment of the rect: one set_d each.
  const mixed = clearInputs(
    doc,
    [rect.id, curve.id],
    [anchorKey(curve.id, 0, 2)],
    [anchorKey(rect.id, 0, 0)],
  );
  expect(mixed.deleteIds).toEqual([]);
  expect(mixed.edits.map((e) => e.nodeId)).toEqual([curve.id, rect.id]);
  // Both segments of a one-segment path leave nothing: it goes.
  const line = createNodes(doc, [
    { type: "path", parentId: rect.parentId, d: "M 0 0 L 5 5" },
  ] as never).nodes[0] as Node;
  expect(clearInputs(doc, [line.id], [], [anchorKey(line.id, 0, 0)])).toEqual({
    edits: [],
    deleteIds: [line.id],
  });
});

it("a selected segment shows the Handles at its ends, and pick grabs them", () => {
  const { doc, curve } = fixture();
  const first = anchorKey(curve.id, 0, 0);
  expect(segmentHandles(doc, first)).toEqual([
    { key: first, which: "handleOut" },
    { key: anchorKey(curve.id, 0, 1), which: "handleIn" },
  ]);
  // The middle Anchor's in Handle sits at (120, 10).
  expect(pick(doc, [curve.id], [], 120, 9, 2, [first])).toEqual({
    kind: "handle",
    key: anchorKey(curve.id, 0, 1),
    which: "handleIn",
  });
  expect(pick(doc, [curve.id], [], 120, 9, 2)).toBeNull();
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

it("Remove Anchor Points removes selected Anchors keeping the path joined, and a path left bare goes", () => {
  const { doc, rect, curve } = fixture();
  const keys = [anchorKey(rect.id, 0, 1), anchorKey(rect.id, 0, 3), anchorKey(rect.id, 0, 9)];
  const all = [0, 1, 2].map((i) => anchorKey(curve.id, 0, i));
  expect(removeAnchorInputs(doc, [...keys, ...all])).toEqual({
    edits: [
      {
        nodeId: rect.id,
        ops: [
          { op: "remove_anchor", subpath: 0, index: 3 },
          { op: "remove_anchor", subpath: 0, index: 1 },
        ],
      },
    ],
    deleteIds: [curve.id],
  });
});

it("Remove Anchor Points drops a subpath it would leave as a Stray Point", () => {
  const { doc, rect } = fixture();
  const [two] = createNodes(doc, [
    { type: "path", parentId: rect.parentId, d: "M 0 0 L 10 0 M 0 20 L 10 20 L 20 20" },
  ] as never).nodes as [Node];
  expect(removeAnchorInputs(doc, [anchorKey(two.id, 0, 1)])).toEqual({
    edits: [
      {
        nodeId: two.id,
        ops: [
          { op: "remove_anchor", subpath: 0, index: 1 },
          { op: "remove_anchor", subpath: 0, index: 0 },
        ],
      },
    ],
    deleteIds: [],
  });
  // Both subpaths left bare: the path goes.
  const keys = [anchorKey(two.id, 0, 0), anchorKey(two.id, 1, 0), anchorKey(two.id, 1, 2)];
  expect(removeAnchorInputs(doc, keys)).toEqual({ edits: [], deleteIds: [two.id] });
});

it("Join and Average take the selected Anchors, Join a wholly selected path whole, else the Selection's paths", () => {
  const { doc, rect, curve } = fixture();
  const end = anchorKey(curve.id, 0, 2);
  const square = [0, 1, 2, 3].map((i) => anchorKey(rect.id, 0, i));
  expect(anchorOpTargets(doc, [rect.id, curve.id], [end, ...square], "join")).toEqual({
    nodeIds: [curve.id],
    anchors: [{ nodeId: curve.id, subpath: 0, index: 2 }],
  });
  expect(anchorOpTargets(doc, [rect.id], square, "join")).toEqual({ nodeIds: [rect.id] });
  expect(anchorOpTargets(doc, [rect.id], square, "average")?.anchors).toHaveLength(4);
  expect(anchorOpTargets(doc, [], [], "average")).toBeNull();
  const [dot] = createNodes(doc, [{ type: "path", parentId: rect.parentId as string, d: "M 5 5" }])
    .nodes as [Node];
  expect(anchorOpTargets(doc, [dot.id, curve.id], [anchorKey(dot.id, 0, 0), end], "join")).toEqual({
    nodeIds: [dot.id, curve.id],
    anchors: [
      { nodeId: dot.id, subpath: 0, index: 0 },
      { nodeId: curve.id, subpath: 0, index: 2 },
    ],
  });
});
