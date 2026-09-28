import {
  createDocument,
  createNodes,
  editPath,
  type Node,
  parsePath,
  toAnchors,
} from "@zibel/core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  curvatureClearInputs,
  curvatureDown,
  curvatureDrag,
  curvatureUp,
  curveThrough,
  moveInput,
  removeCurveAnchor,
  toggleInput,
} from "./curvature.ts";
import { anchorKey } from "./direct.ts";
import { DEFAULT_FILL_STROKE, send, useStore } from "./store.ts";
import { finishPen, undoAnchor } from "./tools.ts";

vi.mock("./store.ts", async (original) => ({
  ...(await original<typeof import("./store.ts")>()),
  send: vi.fn(() => "sent"),
}));

type Point = [number, number];
const click = (p: Point, alt = false) => {
  curvatureDown(p, 1, alt);
  curvatureUp();
};
/** Clicks far enough apart in time that none is a double-click. */
const clicks = (...ps: Point[]) => {
  for (const p of ps) {
    vi.advanceTimersByTime(1000);
    click(p);
  }
};
const sentD = () => {
  const [command] = vi.mocked(send).mock.lastCall ?? [];
  if (command?.type !== "create") throw new Error("no create");
  const [node] = command.nodes;
  if (node?.type !== "path") throw new Error("no path");
  return node.d;
};
const anchorsOfD = (d: string) => toAnchors(parsePath(d, "d"));

const created = createDocument({ id: "d", name: "Doc", artboards: [{ width: 100, height: 100 }] });
const { defaultLayerId } = created;

beforeEach(() => {
  vi.useFakeTimers();
  // No press of the last test pairs with this one's into a double-click.
  vi.advanceTimersByTime(1000);
  useStore.setState({
    doc: created.doc,
    selection: [],
    anchors: [],
    segments: [],
    pen: null,
    pending: [],
    tool: "curvature",
    fillStroke: DEFAULT_FILL_STROKE,
  });
  vi.mocked(send).mockClear();
});

it("runs a smooth curve through the Anchors, straight between two, closing all the way round", () => {
  const smooth = (at: Point) => ({ at, smooth: true });
  expect(curveThrough([smooth([0, 0]), smooth([10, 0])], false)).toEqual([
    { anchor: [0, 0], handleIn: null, handleOut: null },
    { anchor: [10, 0], handleIn: null, handleOut: null },
  ]);
  // The middle Anchor's Handles lie along its neighbours' chord, the Endpoints' are left out.
  const [a, b, c] = curveThrough([smooth([0, 0]), smooth([10, 10]), smooth([20, 0])], false);
  expect(a?.handleOut).toBeNull();
  expect(c?.handleIn).toBeNull();
  expect(b?.handleIn?.[1]).toBeCloseTo(10);
  expect(b?.handleOut?.[1]).toBeCloseTo(10);
  expect(b?.handleIn?.[0]).toBeLessThan(10);
  expect(b?.handleOut?.[0]).toBeGreaterThan(10);
  // A Corner has no Handles.
  const corner = curveThrough(
    [smooth([0, 0]), { at: [10, 10], smooth: false }, smooth([20, 0])],
    true,
  );
  expect(corner[1]).toEqual({ anchor: [10, 10], handleIn: null, handleOut: null });
  expect(corner[0]?.handleIn).not.toBeNull();
  // Four Anchors on a circle close into one: its Handles are a quarter circle's 0.5523 of the radius.
  const ring = curveThrough(
    [smooth([10, 0]), smooth([0, 10]), smooth([-10, 0]), smooth([0, -10])],
    true,
  );
  expect(ring[0]?.handleOut?.[1]).toBeCloseTo(5.523, 2);
});

it("four clicks and Esc commit one smooth open path through the four Anchors", () => {
  clicks([0, 0], [20, 20], [40, 0], [60, 20]);
  expect(send).not.toHaveBeenCalled();
  finishPen();
  expect(send).toHaveBeenCalledTimes(1);
  const [sub] = anchorsOfD(sentD());
  expect(sub?.closed).toBe(false);
  expect(sub?.anchors.map((a) => a.anchor)).toEqual([
    [0, 0],
    [20, 20],
    [40, 0],
    [60, 20],
  ]);
  expect(sub?.anchors.map((a) => a.type)).toEqual(["corner", "smooth", "smooth", "corner"]);
  expect(sentD()).toMatch(/^M 0 0 C( [\d.-]+){6} C( [\d.-]+){6} C( [\d.-]+){6}$/);
});

it("a double-click or an Alt-click places a Corner, and a click on the first Anchor closes", () => {
  clicks([0, 0], [20, 20]);
  click([20.5, 20]); // The second click of a double-click, at once.
  clicks([40, 0]);
  click([60, 20], true);
  clicks([60, 40], [0, 0]);
  const [sub] = anchorsOfD(sentD());
  expect(sub?.closed).toBe(true);
  expect(sub?.anchors.map((a) => a.type)).toEqual([
    "smooth",
    "corner",
    "smooth",
    "corner",
    "smooth",
  ]);
});

it("a click on the only Anchor does not close the path", () => {
  clicks([0, 0], [0, 0]);
  expect(send).not.toHaveBeenCalled();
  expect(useStore.getState().pen?.curve).toEqual([{ at: [0, 0], smooth: true }]);
});

it("dragging an Anchor moves it, Delete removes one, and Ctrl+Z the last", () => {
  clicks([0, 0], [20, 20], [40, 0]);
  vi.advanceTimersByTime(1000);
  curvatureDown([20, 20], 1, false);
  curvatureDrag([20, 30]);
  curvatureUp();
  expect(useStore.getState().pen?.curve?.map((p) => p.at)).toEqual([
    [0, 0],
    [20, 30],
    [40, 0],
  ]);
  // Delete takes the Anchor pressed last.
  expect(removeCurveAnchor()).toBe(true);
  expect(useStore.getState().pen?.curve?.map((p) => p.at)).toEqual([
    [0, 0],
    [40, 0],
  ]);
  expect(undoAnchor()).toBe(true);
  expect(useStore.getState().pen?.curve?.map((p) => p.at)).toEqual([[0, 0]]);
  expect(useStore.getState().pen?.anchors).toHaveLength(1);
});

// A committed curve: 0 and 3 are Endpoints, 1 and 2 Smooth.
const committed = () => {
  const doc = structuredClone(created.doc);
  const d = "M 0 0 C 0 0 10 20 20 20 C 30 20 30 0 40 0 C 50 0 60 20 60 20";
  const [{ id }] = createNodes(doc, [{ type: "path", parentId: defaultLayerId, d }] as never)
    .nodes as [Node];
  const edited = (input: ReturnType<typeof toggleInput>) => {
    if (!input) throw new Error("no input");
    const next = structuredClone(doc);
    editPath(next, input);
    const n = next.nodes.get(id);
    if (n?.type !== "path") throw new Error("no path");
    return anchorsOfD(n.d)[0]?.anchors ?? [];
  };
  return { doc, id, edited };
};

it("a double-click toggles an existing Anchor's type in one path_edit", () => {
  const { doc, id, edited } = committed();
  const input = toggleInput(doc, anchorKey(id, 0, 1));
  expect(input).toMatchObject({ nodeId: id, ops: [{ op: "set_point_type", type: "corner" }] });
  expect(edited(input).map((a) => a.type)).toEqual(["corner", "corner", "smooth", "corner"]);
  // An Endpoint is always a Corner.
  expect(toggleInput(doc, anchorKey(id, 0, 0))).toBeNull();
});

it("toggles through the tool: a second press on a selected Anchor at once", () => {
  const { doc, id } = committed();
  useStore.setState({ doc, selection: [id] });
  click([20, 20]);
  expect(useStore.getState().anchors).toEqual([anchorKey(id, 0, 1)]);
  expect(send).not.toHaveBeenCalled();
  click([20, 20]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(vi.mocked(send).mock.lastCall?.[0]).toMatchObject({ type: "path_edit" });
});

it("moving an Anchor reshapes its Smooth neighbours through it", () => {
  const { doc, id, edited } = committed();
  const moved = edited(moveInput(doc, anchorKey(id, 0, 1), [0, 20]));
  expect(moved.map((a) => a.anchor)).toEqual([
    [0, 0],
    [20, 40],
    [40, 0],
    [60, 20],
  ]);
  expect(moved.map((a) => a.type)).toEqual(["corner", "smooth", "smooth", "corner"]);
  // Anchor 2's Handles now lie along 1 to 3's chord.
  const [x, y] = moved[2]?.handleOut ?? [0, 0];
  expect(y / (x - 40)).toBeCloseTo((20 - 40) / (60 - 20), 2);
});

it("Delete removes an Anchor and keeps the curve connected", () => {
  const { doc, id } = committed();
  const { edits, deleteIds } = curvatureClearInputs(doc, [id], [anchorKey(id, 0, 2)]);
  expect(deleteIds).toEqual([]);
  const [edit] = edits;
  const op = edit?.ops[0];
  if (op?.op !== "set_d") throw new Error("no set_d");
  const [sub] = anchorsOfD(op.d);
  expect(sub?.anchors.map((a) => a.anchor)).toEqual([
    [0, 0],
    [20, 20],
    [60, 20],
  ]);
  expect(sub?.anchors[1]?.type).toBe("smooth");
  // Down to one Anchor, the path goes.
  expect(
    curvatureClearInputs(
      doc,
      [id],
      [0, 1, 2].map((i) => anchorKey(id, 0, i)),
    ).deleteIds,
  ).toEqual([id]);
});
