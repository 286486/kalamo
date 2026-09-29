import {
  createDocument,
  createNodes,
  editPath,
  type Node,
  type PathEditInput,
  parsePath,
  toAnchors,
} from "@zibel/core";
import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_PENCIL, pencilDown, pencilMove, pencilUp, savePencilOptions } from "./pencil.ts";
import { DEFAULT_FILL_STROKE, send, useStore } from "./store.ts";

vi.mock("./store.ts", async (original) => ({
  ...(await original<typeof import("./store.ts")>()),
  send: vi.fn(() => "sent"),
}));

type Point = [number, number];
const NONE = { shift: false, alt: false };
/** A drag through the points, each move reporting one, at 100%. */
const stroke = (points: Point[], mods = NONE) => {
  pencilDown(points[0] as Point);
  for (const p of points.slice(1)) pencilMove([p], mods);
  pencilUp(1);
};
const range = (n: number, f: (t: number) => Point) =>
  Array.from({ length: n + 1 }, (_, i) => f(i / n));
const commands = () => vi.mocked(send).mock.calls.map(([c]) => c);
const createdD = () => {
  const [command, ...rest] = commands();
  if (command?.type !== "create" || rest.length) throw new Error("not one create");
  const [node] = command.nodes;
  if (node?.type !== "path") throw new Error("no path");
  return node;
};
const subpaths = (d: string) => toAnchors(parsePath(d, "d"));

const created = createDocument({ id: "d", name: "Doc", artboards: [{ width: 200, height: 200 }] });
const { defaultLayerId } = created;

/** A Document with one path of `d`, selected. */
const withPath = (d: string) => {
  const doc = structuredClone(created.doc);
  const [{ id }] = createNodes(doc, [{ type: "path", parentId: defaultLayerId, d }] as never)
    .nodes as [Node];
  useStore.setState({ doc, selection: [id] });
  /** The path after the one path_edit sent. */
  const edited = () => {
    const [command, ...rest] = commands();
    if (command?.type !== "path_edit" || rest.length) throw new Error("not one path_edit");
    const next = structuredClone(doc);
    const { node } = editPath(next, command.input as PathEditInput);
    return node;
  };
  return { id, edited };
};

beforeEach(() => {
  savePencilOptions(DEFAULT_PENCIL);
  useStore.setState({
    doc: created.doc,
    selection: [],
    pen: null,
    pending: [],
    edit: null,
    fillStroke: DEFAULT_FILL_STROKE,
  });
  vi.mocked(send).mockClear();
});

it("a stroke commits one create with the fitted path, stroked but not filled", () => {
  const ink = range(60, (t) => [20 + 160 * t, 100 + 30 * Math.sin(t * 2 * Math.PI)]);
  stroke(ink);
  const node = createdD();
  expect(node.appearance).toEqual({ fills: [], strokes: [{ color: "#000000", width: 1 }] });
  const [sub] = subpaths(node.d);
  expect(sub?.closed).toBe(false);
  // Fitted: a few curves from the first point to the last, not one per point.
  expect(sub?.anchors[0]?.anchor).toEqual([20, 100]);
  expect(sub?.anchors.at(-1)?.anchor).toEqual([180, 100]);
  expect(sub?.anchors.length).toBeLessThan(8);
  expect(node.d).toContain("C");
  expect(useStore.getState().pending).toMatchObject([{ commandId: "sent", select: true }]);
});

it("ending within the close distance of the start closes the path", () => {
  // Round a circle, stopping 10 px short of where it began.
  const ink = range(60, (t) => {
    const a = t * (2 * Math.PI - 10 / 50);
    return [100 + 50 * Math.cos(a), 100 + 50 * Math.sin(a)];
  });
  stroke(ink);
  expect(createdD().d).toMatch(/ Z$/);
  // Farther than 15 px stays open.
  vi.mocked(send).mockClear();
  stroke(ink.slice(0, -5));
  expect(createdD().d).not.toMatch(/Z/);
});

it("Shift draws one straight segment at 0, 45 or 90°, and Alt one at any angle", () => {
  stroke(
    [
      [10, 10],
      [30, 12],
      [60, 13],
    ],
    { shift: true, alt: false },
  );
  expect(createdD().d).toBe("M 10 10 L 60 10");
  vi.mocked(send).mockClear();
  stroke(
    [
      [10, 10],
      [30, 12],
      [60, 13],
    ],
    { shift: false, alt: true },
  );
  expect(createdD().d).toBe("M 10 10 L 60 13");
});

it("Fill new pencil strokes fills with the current Fill; Keep selected off leaves it unselected", () => {
  savePencilOptions({ ...DEFAULT_PENCIL, fillNew: true, keepSelected: false });
  stroke(range(10, (t) => [10 + 50 * t, 10 + 20 * t * t]));
  expect(createdD().appearance?.fills).toEqual([{ color: "#FFFFFF" }]);
  expect(useStore.getState().pending.at(-1)?.select).toBe(false);
});

it("redrawing across a selected path replaces that part in one path_edit", () => {
  const { id, edited } = withPath("M 0 100 L 200 100");
  // From on the line at x 50, down through y 140, back onto it at x 150.
  stroke(range(40, (t) => [50 + 100 * t, 101 + 40 * Math.sin(t * Math.PI)]));
  const node = edited();
  expect(node.id).toBe(id);
  const [sub, ...more] = subpaths(node.d);
  expect(more).toEqual([]);
  const at = sub?.anchors.map((a) => a.anchor) ?? [];
  // The ends stay; the part between x 50 and 150 now dips to y 140.
  expect(at[0]).toEqual([0, 100]);
  expect(at.at(-1)).toEqual([200, 100]);
  expect(at.some(([x, y]) => x > 50 && x < 150 && y === 100)).toBe(false);
  expect(
    Math.max(...(sub?.anchors ?? []).flatMap((a) => [a.anchor[1], a.handleIn?.[1] ?? 0])),
  ).toBeGreaterThan(130);
});

it("redrawing a selected closed path keeps it closed", () => {
  const { edited } = withPath("M 50 50 L 150 50 L 150 150 L 50 150 Z");
  // Out across the top edge and back onto it.
  stroke(range(40, (t) => [70 + 60 * t, 50 - 30 * Math.sin(t * Math.PI)]));
  const [sub] = subpaths(edited().d);
  expect(sub?.closed).toBe(true);
  const at = sub?.anchors.map((a) => a.anchor) ?? [];
  for (const corner of [
    [50, 50],
    [150, 50],
    [150, 150],
    [50, 150],
  ])
    expect(at).toContainEqual(corner);
  expect(Math.min(...at.map(([, y]) => y))).toBeLessThan(35);
});

it("a stroke from a selected path's Endpoint extends it, and back to the other one closes it", () => {
  const { edited } = withPath("M 0 100 L 100 100");
  stroke(range(10, (t) => [100 + 50 * t, 100]));
  expect(edited().d).toBe("M 0 100 L 100 100 L 150 100");

  vi.mocked(send).mockClear();
  // From the first Endpoint: the path keeps its direction.
  stroke(range(10, (t) => [-50 * t, 100]));
  expect(edited().d).toBe("M -50 100 L 0 100 L 100 100");

  vi.mocked(send).mockClear();
  // Round from the last Endpoint to 5 px of the first.
  stroke(range(30, (t) => [100 - 95 * t, 100 - 60 * Math.sin(t * Math.PI)]));
  const [sub] = subpaths(edited().d);
  expect(sub?.closed).toBe(true);
  expect(sub?.anchors[0]?.anchor).toEqual([0, 100]);
});

it("a stroke away from an unselected path draws a new one", () => {
  withPath("M 0 100 L 200 100");
  useStore.setState({ selection: [] });
  stroke(range(10, (t) => [50 + 100 * t, 100 + 20 * t]));
  expect(createdD().d).toMatch(/^M 50 100 /);
});

it("a wiggle on a selected path does not cut it", () => {
  withPath("M 0 100 L 200 100");
  stroke([
    [100, 101],
    [101, 101],
  ]);
  expect(commands().some((c) => c.type === "path_edit")).toBe(false);
});

it("Ink starting between two selected paths edits the nearer", () => {
  const doc = structuredClone(created.doc);
  const ids = createNodes(doc, [
    { type: "path", parentId: defaultLayerId, d: "M 0 100 L 200 100" },
    { type: "path", parentId: defaultLayerId, d: "M 0 110 L 200 110" },
  ] as never).nodes.map((n) => n.id);
  useStore.setState({ doc, selection: ids });
  stroke(range(20, (t) => [50 + 100 * t, 108 + 30 * Math.sin(t * Math.PI)]));
  const [command] = commands();
  expect(command?.type === "path_edit" && command.input.nodeId).toBe(ids[1]);
});
