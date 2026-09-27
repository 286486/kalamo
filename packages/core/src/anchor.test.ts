import { describe, expect, it } from "vitest";
import type { PathNode } from "./anchor.ts";
import { convertToPath, editPath, fromAnchors, type PathOp, pathOp, toAnchors } from "./anchor.ts";
import { createDocument, createNodes } from "./document.ts";
import { ZibelError } from "./errors.ts";
import { formatPath, parsePath, type Segment } from "./path.ts";

const roundTrip = (d: string) => formatPath(fromAnchors(toAnchors(parsePath(d, "d"))));

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ZibelError) return e.data;
    throw e;
  }
  throw new Error("expected a ZibelError");
};

describe("toAnchors and fromAnchors", () => {
  it("round-trips every fixture path exactly", () => {
    const files = import.meta.glob("../../../fixtures/documents/*.zibel.json", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const ds = Object.values(files).flatMap((text) =>
      (JSON.parse(text) as { nodes: { d?: string }[] }).nodes.flatMap((n) => n.d ?? []),
    );
    expect(ds.length).toBeGreaterThan(0);
    for (const d of ds) expect(roundTrip(d)).toBe(d);
  });

  it.each([
    "M 0 0",
    "M 0 0 Z",
    "M 0 0 L 10 0 L 10 10 Z",
    "M 0 0 L 10 0 L 10 10 L 0 0 Z",
    "M 0 0 C 10 0 10 10 0 10 C -10 10 -10 0 0 0 Z",
    "M 0 0 C 10 0 10 10 0 0 Z",
    "M 0 0 C 0 5 10 5 10 10 L 20 10",
    "M 0 0 C 5 5 5 5 10 0 L 0 0 Z",
    "M 0 0 Q 5 10 10 0 Q 15 -10 20 0",
    "M 0 0 L 10 0 Z M 20 20 L 30 20 L 30 30",
    "M 0 0 L 10 0 C 10 5 2 2 0 0 L 0 0 Z",
  ])("round-trips %s", (d) => {
    expect(roundTrip(d)).toBe(d);
  });

  it("gives each Anchor its Handles and derives Smooth from collinear Handles (ADR-0032)", () => {
    const [circle] = toAnchors(
      parsePath("M 0 -10 C 5 -10 10 -5 10 0 C 10 5 5 10 0 10 C -5 10 -10 0 0 -10 Z", "d"),
    );
    expect(circle?.closed).toBe(true);
    expect(circle?.anchors).toEqual([
      { anchor: [0, -10], handleIn: [-10, 0], handleOut: [5, -10], type: "corner" },
      { anchor: [10, 0], handleIn: [10, -5], handleOut: [10, 5], type: "smooth" },
      { anchor: [0, 10], handleIn: [5, 10], handleOut: [-5, 10], type: "smooth" },
    ]);
  });

  it("makes an Anchor with a missing Handle a Corner", () => {
    const [open] = toAnchors(parsePath("M 0 0 C 0 5 5 10 10 10 L 20 10", "d"));
    expect(open?.anchors.map((a) => a.type)).toEqual(["corner", "corner", "corner"]);
    expect(open?.anchors[1]).toMatchObject({ handleIn: [5, 10], handleOut: null });
  });

  it("stays Smooth when rounding to 3 decimals bent short Handles", () => {
    const [p] = toAnchors(parsePath("M 0 0 C 0 0 0.999 0.001 1 0 C 1.001 0 2 0 2 0", "d"));
    expect(p?.anchors[1]?.type).toBe("smooth");
  });
});

const setup = (d: string) => {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const [node] = createNodes(doc, [{ type: "path", parentId: defaultLayerId, d }]).nodes;
  if (!node) throw new Error("setup");
  const edit = (...ops: PathOp[]) => editPath(doc, { nodeId: node.id, ops });
  return { doc, node, defaultLayerId, edit };
};

/** A point on a Bézier segment (2, 3 or 4 points) by de Casteljau. */
const at = (p: number[][], t: number): number[] =>
  p.length === 1
    ? (p[0] as number[])
    : at(
        p.slice(1).map((q, i) => q.map((v, k) => (1 - t) * ((p[i] as number[])[k] ?? 0) + t * v)),
        t,
      );

/** Each drawn segment of `d` as its control points, starting at the pen position. */
const pieces = (d: string): number[][][] => {
  const out: number[][][] = [];
  let pen = [0, 0];
  let start = [0, 0];
  for (const { cmd, args } of parsePath(d, "d") as Segment[]) {
    const pts = Array.from({ length: args.length / 2 }, (_, k) => args.slice(2 * k, 2 * k + 2));
    if (cmd === "M") [pen, start] = [pts[0] as number[], pts[0] as number[]];
    else if (cmd === "Z") {
      out.push([pen, start]);
      pen = start;
    } else {
      out.push([pen, ...pts]);
      pen = pts.at(-1) as number[];
    }
  }
  return out;
};

describe("editPath", () => {
  it("move_anchor moves an Anchor and its Handles, in the path's own coordinates", () => {
    const { edit } = setup("M 0 0 C 0 10 10 20 20 20 C 30 20 40 10 40 0");
    const { node, subpaths } = edit({ op: "move_anchor", index: 1, to: [25, 30] });
    expect(node.d).toBe("M 0 0 C 0 10 15 30 25 30 C 35 30 40 10 40 0");
    expect(subpaths[0]?.anchors[1]).toEqual({
      index: 1,
      anchor: [25, 30],
      handleIn: [15, 30],
      handleOut: [35, 30],
      type: "smooth",
    });
  });

  it("set_handles sets one Handle, retracts another with null and keeps an omitted one", () => {
    const { edit } = setup("M 0 0 C 0 10 10 20 20 20 C 30 20 40 10 40 0");
    expect(edit({ op: "set_handles", index: 1, handleIn: [20, 30] }).node.d).toBe(
      "M 0 0 C 0 10 20 30 20 20 C 30 20 40 10 40 0",
    );
    expect(edit({ op: "set_handles", index: 1, handleIn: null, handleOut: null }).node.d).toBe(
      "M 0 0 C 0 10 20 20 20 20 C 20 20 40 10 40 0",
    );
  });

  it("set_handles refuses a Handle an Endpoint of an open subpath does not have", () => {
    const { edit } = setup("M 0 0 L 10 0");
    expect(errorOf(() => edit({ op: "set_handles", index: 0, handleIn: [1, 1] }))).toMatchObject({
      code: "INVALID_PATH",
      path: "ops[0].handleIn",
    });
  });

  it("set_point_type smooth pulls Handles out along the neighbours; corner retracts them", () => {
    const { edit } = setup("M 0 0 L 30 30 L 60 0");
    const smooth = edit({ op: "set_point_type", index: 1, type: "smooth" });
    expect(smooth.node.d).toBe("M 0 0 C 0 0 15.858 30 30 30 C 44.142 30 60 0 60 0");
    expect(smooth.subpaths[0]?.anchors[1]?.type).toBe("smooth");
    expect(edit({ op: "set_point_type", index: 1, type: "corner" }).node.d).toBe(
      "M 0 0 L 30 30 L 60 0",
    );
  });

  it("set_point_type smooth lines up broken Handles and keeps their lengths", () => {
    const { edit } = setup("M 0 0 C 0 0 20 20 30 20 C 30 30 60 0 60 0");
    const { subpaths } = edit({ op: "set_point_type", index: 1, type: "smooth" });
    const { handleIn, handleOut, type } = subpaths[0]?.anchors[1] ?? {};
    expect(type).toBe("smooth");
    expect(Math.hypot((handleIn?.[0] ?? 0) - 30, (handleIn?.[1] ?? 0) - 20)).toBeCloseTo(10, 2);
    expect(Math.hypot((handleOut?.[0] ?? 0) - 30, (handleOut?.[1] ?? 0) - 20)).toBeCloseTo(10, 2);
  });

  it("set_point_type smooth refuses an Endpoint", () => {
    const { edit } = setup("M 0 0 L 30 30");
    expect(errorOf(() => edit({ op: "set_point_type", index: 0, type: "smooth" }))).toMatchObject({
      code: "INVALID_PATH",
      path: "ops[0].index",
    });
  });

  it.each([
    ["a line", "M 0 0 L 40 0 L 40 40", 1, 0.25],
    ["a cubic", "M 0 0 C 0 40 40 40 40 0", 0, 0.3],
    ["a quadratic", "M 0 0 Q 20 40 40 0", 0, 0.5],
    ["the closing segment", "M 0 0 L 40 0 C 40 40 0 40 0 0 Z", 1, 0.5],
  ])("add_anchor splits %s without changing its shape", (_, d, segment, t) => {
    const { edit } = setup(d);
    const before = pieces(d);
    const { node, subpaths } = edit({ op: "add_anchor", segment, t });
    const after = pieces(node.d);
    expect(after).toHaveLength(before.length + 1);
    expect(subpaths[0]?.anchors).toHaveLength(
      (toAnchors(parsePath(d, "d"))[0]?.anchors ?? []).length + 1,
    );
    const old = before[segment] as number[][];
    for (const s of [0, 0.2, 0.5, 0.8, 1]) {
      const [a, b] = [after[segment] as number[][], after[segment + 1] as number[][]];
      const near = (p: number[], q: number[]) => p.map((v, k) => v - (q[k] ?? 0));
      for (const off of [
        ...near(at(a, s), at(old, s * t)),
        ...near(at(b, s), at(old, t + s * (1 - t))),
      ]) {
        expect(off).toBeCloseTo(0, 2);
      }
    }
  });

  it("remove_anchor joins its neighbours, and drops an Endpoint's dangling Handle", () => {
    const { edit } = setup("M 0 0 L 10 0 L 20 0 Z");
    expect(edit({ op: "remove_anchor", index: 1 }).node.d).toBe("M 0 0 L 20 0 Z");
    const open = setup("M 0 0 C 5 5 5 5 10 0 L 20 0");
    expect(open.edit({ op: "remove_anchor", index: 0 }).node.d).toBe("M 10 0 L 20 0");
  });

  it("remove_anchor removes a one-Anchor subpath but never the last Anchor", () => {
    const { edit } = setup("M 0 0 L 10 0 M 50 50");
    expect(edit({ op: "remove_anchor", subpath: 1, index: 0 }).node.d).toBe("M 0 0 L 10 0");
    const lone = setup("M 0 0");
    expect(errorOf(() => lone.edit({ op: "remove_anchor", index: 0 }))).toMatchObject({
      code: "INVALID_PATH",
      hint: expect.stringMatching(/node_delete/),
    });
  });

  it("close closes with a line, merging a last Anchor that sits on the first", () => {
    expect(setup("M 0 0 L 10 0 L 10 10").edit({ op: "close" }).node.d).toBe(
      "M 0 0 L 10 0 L 10 10 Z",
    );
    const { node, subpaths } = setup("M 0 0 C 5 0 10 5 10 10 C 5 10 0 5 0 0").edit({
      op: "close",
    });
    expect(node.d).toBe("M 0 0 C 5 0 10 5 10 10 C 5 10 0 5 0 0 Z");
    expect(subpaths[0]?.anchors).toHaveLength(2);
  });

  it("open keeps the outline, ending on a copy of the first Anchor", () => {
    expect(setup("M 0 0 L 10 0 L 10 10 Z").edit({ op: "open" }).node.d).toBe(
      "M 0 0 L 10 0 L 10 10 L 0 0",
    );
    expect(setup("M 0 0 C 5 0 10 5 10 10 C 5 10 0 5 0 0 Z").edit({ op: "open" }).node.d).toBe(
      "M 0 0 C 5 0 10 5 10 10 C 5 10 0 5 0 0",
    );
  });

  it("reverse reverses every subpath, or one, keeping a closed subpath's start", () => {
    const { edit } = setup("M 0 0 C 0 10 10 10 10 0 M 20 0 L 30 0 L 30 10 Z");
    expect(edit({ op: "reverse", subpath: 1 }).node.d).toBe(
      "M 0 0 C 0 10 10 10 10 0 M 20 0 L 30 10 L 30 0 Z",
    );
    expect(edit({ op: "reverse" }).node.d).toBe("M 10 0 C 10 10 0 10 0 0 M 20 0 L 30 0 L 30 10 Z");
  });

  it("set_d replaces d, and later ops see the new Anchors", () => {
    const { edit } = setup("M 0 0 L 10 0");
    expect(
      edit({ op: "set_d", d: "M 0 0 L 5 5 L 10 0" }, { op: "move_anchor", index: 2, to: [20, 0] })
        .node.d,
    ).toBe("M 0 0 L 5 5 L 20 0");
  });

  it("keeps an Anchor moved onto the first Anchor", () => {
    const { edit } = setup("M 0 0 L 10 0 C 10 5 5 5 3 3 Z");
    const { node, subpaths } = edit({ op: "move_anchor", index: 2, to: [0, 0] });
    expect(node.d).toBe("M 0 0 L 10 0 C 10 5 2 2 0 0 L 0 0 Z");
    expect(subpaths[0]?.anchors).toHaveLength(3);
    const lined = setup("M 0 0 L 10 0 L 0 0 Z");
    const set = lined.edit({ op: "set_handles", index: 2, handleIn: [5, 5] });
    expect(set.subpaths[0]?.anchors).toHaveLength(3);
    expect(set.subpaths[0]?.anchors[2]?.handleIn).toEqual([5, 5]);
  });

  it("applies ops in order and changes nothing when one fails", () => {
    const { doc, node, edit } = setup("M 0 0 L 10 0");
    const e = errorOf(() =>
      edit(
        { op: "move_anchor", index: 0, to: [5, 5] },
        { op: "move_anchor", index: 7, to: [0, 0] },
      ),
    );
    expect(e).toMatchObject({ code: "INVALID_PATH", path: "ops[1].index" });
    expect((doc.nodes.get(node.id) as PathNode).d).toBe("M 0 0 L 10 0");
  });

  it("converts a Live Shape first and says so in a warning", () => {
    const { doc, defaultLayerId } = setup("M 0 0");
    const [ellipse] = createNodes(doc, [
      { type: "ellipse", parentId: defaultLayerId, x: 0, y: 0, width: 10, height: 10 },
    ]).nodes;
    const id = ellipse?.id ?? "";
    const { node, warnings } = editPath(doc, { nodeId: id, ops: [{ op: "open" }] });
    expect(node).toMatchObject({ id, type: "path" });
    expect(node).not.toHaveProperty("width");
    expect(warnings).toEqual([expect.objectContaining({ code: "CONVERTED_TO_PATH", nodeId: id })]);
  });

  it("refuses a Node without Anchors", () => {
    const { doc, defaultLayerId } = setup("M 0 0");
    const e = errorOf(() => editPath(doc, { nodeId: defaultLayerId, ops: [{ op: "close" }] }));
    expect(e).toMatchObject({ code: "INVALID_PATH", path: "nodeId" });
  });
});

describe("convertToPath", () => {
  it("keeps a rect's id, place, name and appearance, swapping its parameters for d", () => {
    const { doc, defaultLayerId: layer } = setup("M 0 0");
    const [rect] = createNodes(doc, [
      {
        type: "rect",
        parentId: layer,
        name: "Box",
        x: 1,
        y: 2,
        width: 10,
        height: 20,
        appearance: { fills: [{ color: "#FF0000" }] },
      },
    ]).nodes;
    if (!rect) throw new Error("no rect");
    const { updated } = convertToPath(doc, [rect.id]);
    const {
      x: _x,
      y: _y,
      width: _w,
      height: _h,
      radius: _r,
      ...kept
    } = rect as typeof rect & {
      type: "rect";
    };
    expect(updated).toEqual([
      { ...kept, type: "path", d: "M 1 2 L 11 2 L 11 22 L 1 22 Z", fillRule: "nonzero" },
    ]);
    expect(doc.nodes.get(rect.id)).toBe(updated[0]);
  });

  it("leaves a path as it is and refuses a Node without Anchors", () => {
    const { doc, node, defaultLayerId } = setup("M 0 0 L 10 0");
    expect(convertToPath(doc, [node.id]).updated).toEqual([]);
    expect(doc.nodes.get(node.id)).toBe(node);
    const e = errorOf(() => convertToPath(doc, [defaultLayerId]));
    expect(e).toMatchObject({ code: "INVALID_PATH", path: "nodeIds[0]" });
  });
});

describe("pathOp", () => {
  const anchorCount = (d: string) =>
    toAnchors(parsePath(d, "d")).reduce((n, s) => n + s.anchors.length, 0);
  const d = "M 0 0 C 0 10 20 10 20 0 L 30 5 Z M 50 50 L 60 50 Q 70 60 80 50";

  it("reverse twice returns the original d", () => {
    const { doc, node } = setup(d);
    pathOp(doc, { nodeIds: [node.id], op: "reverse" });
    const once = doc.nodes.get(node.id) as PathNode;
    expect(once.d).not.toBe(d);
    expect(once.d.startsWith("M 0 0 L 30 5")).toBe(true);
    pathOp(doc, { nodeIds: [node.id], op: "reverse" });
    expect((doc.nodes.get(node.id) as PathNode).d).toBe(d);
  });

  it("add_anchors doubles the Anchors and keeps the outline", () => {
    const { doc, node } = setup(d);
    const { updated } = pathOp(doc, { nodeIds: [node.id], op: "add_anchors" });
    const next = updated[0] as PathNode;
    expect(anchorCount(next.d)).toBe(2 * anchorCount(d) - 1);
    expect(next.d).toBe(
      "M 0 0 C 0 5 5 7.5 10 7.5 C 15 7.5 20 5 20 0 L 25 2.5 L 30 5 L 15 2.5 Z " +
        "M 50 50 L 55 50 L 60 50 Q 65 55 70 55 Q 75 55 80 50",
    );
  });

  it("add_anchors doubles a closed subpath's Anchors, closing segment included", () => {
    const { doc, node } = setup("M 0 0 L 10 0 L 10 10 L 0 10 Z");
    pathOp(doc, { nodeIds: [node.id], op: "add_anchors" });
    expect(anchorCount((doc.nodes.get(node.id) as PathNode).d)).toBe(8);
  });

  it("converts a Live Shape first, with a warning, and refuses a Node without Anchors", () => {
    const { doc, defaultLayerId: layer } = setup("M 0 0");
    const [rect] = createNodes(doc, [
      { type: "rect", parentId: layer, x: 0, y: 0, width: 10, height: 10 },
    ]).nodes;
    if (!rect) throw new Error("no rect");
    const { updated, warnings } = pathOp(doc, { nodeIds: [rect.id], op: "reverse" });
    expect(updated[0]).toMatchObject({
      id: rect.id,
      type: "path",
      d: "M 0 0 L 0 10 L 10 10 L 10 0 Z",
    });
    expect(warnings).toEqual([
      expect.objectContaining({ code: "CONVERTED_TO_PATH", nodeId: rect.id }),
    ]);
    const e = errorOf(() => pathOp(doc, { nodeIds: [layer], op: "add_anchors" }));
    expect(e).toMatchObject({ code: "INVALID_PATH", path: "nodeIds[0]" });
  });
});

describe("pathOp join", () => {
  const paths = (...ds: string[]) => {
    const { doc, defaultLayerId, node } = setup(ds[0] as string);
    const rest = createNodes(
      doc,
      ds.slice(1).map((d) => ({ type: "path" as const, parentId: defaultLayerId, d })),
    ).nodes;
    return { doc, defaultLayerId, ids: [node.id, ...rest.map((n) => n.id)] };
  };
  const dOf = (doc: ReturnType<typeof setup>["doc"], id: string) =>
    (doc.nodes.get(id) as PathNode).d;

  it("joins two open paths by their closest Endpoints into the topmost, deleting the other", () => {
    const { doc, ids } = paths("M 0 0 L 10 0", "M 30 0 L 20 0");
    const [a, b] = ids as [string, string];
    const { updated, deletedIds } = pathOp(doc, { nodeIds: [a, b], op: "join" });
    expect(updated.map((n) => n.id)).toEqual([b]);
    expect(deletedIds).toEqual([a]);
    expect(doc.nodes.has(a)).toBe(false);
    // Topmost b's d, its start joined to a's end by a straight segment.
    expect(dOf(doc, b)).toBe("M 30 0 L 20 0 L 10 0 L 0 0");
  });

  it("merges coincident Endpoints into one Anchor, keeping both Handles", () => {
    const { doc, ids } = paths("M 0 0 C 0 10 10 10 10 0", "M 10 0 C 10 -10 20 -10 20 0");
    pathOp(doc, { nodeIds: ids, op: "join" });
    expect(dOf(doc, ids[1] as string)).toBe("M 0 0 C 0 10 10 10 10 0 C 10 -10 20 -10 20 0");
  });

  it("maps the other path through both transforms", () => {
    const { doc, ids } = paths("M 0 0 L 10 0", "M 0 0 L 10 0");
    const [a, b] = ids as [string, string];
    doc.nodes.set(b, { ...(doc.nodes.get(b) as PathNode), transform: [1, 0, 0, 1, 100, 0] });
    pathOp(doc, { nodeIds: ids, op: "join" });
    expect(dOf(doc, b)).toBe("M -100 0 L -90 0 L 0 0 L 10 0");
    expect(doc.nodes.has(a)).toBe(false);
  });

  it("closes one open path alone, merging coincident ends", () => {
    const open = paths("M 0 0 L 10 0 L 10 10");
    pathOp(open.doc, { nodeIds: open.ids, op: "join" });
    expect(dOf(open.doc, open.ids[0] as string)).toBe("M 0 0 L 10 0 L 10 10 Z");
    const ends = paths("M 0 0 L 10 0 L 10 10 L 0 0.001");
    pathOp(ends.doc, { nodeIds: ends.ids, op: "join", tolerance: 0.01 });
    expect(dOf(ends.doc, ends.ids[0] as string)).toBe("M 0 0 L 10 0 L 10 10 Z");
  });

  it("joins three paths into one, closest first, leaving closed paths alone", () => {
    const { doc, ids } = paths("M 0 0 L 10 0", "M 50 0 L 40 0", "M 11 0 L 20 0", "M 0 50 L 5 50 Z");
    const { updated, deletedIds } = pathOp(doc, { nodeIds: ids, op: "join" });
    expect(updated.map((n) => n.id)).toEqual([ids[2]]);
    expect(deletedIds.sort()).toEqual([ids[0], ids[1]].sort());
    expect(dOf(doc, ids[2] as string)).toBe("M 0 0 L 10 0 L 11 0 L 20 0 L 40 0 L 50 0");
    expect(dOf(doc, ids[3] as string)).toBe("M 0 50 L 5 50 Z");
  });

  it("connects two selected Endpoints, and refuses anything else", () => {
    const { doc, ids } = paths("M 0 0 L 10 0 L 10 10", "M 30 0 L 20 0");
    const [a, b] = ids as [string, string];
    pathOp(doc, {
      nodeIds: ids,
      op: "join",
      anchors: [
        { nodeId: a, subpath: 0, index: 0 },
        { nodeId: b, subpath: 0, index: 1 },
      ],
    });
    expect(doc.nodes.has(a)).toBe(false);
    expect(dOf(doc, b)).toBe("M 30 0 L 20 0 L 0 0 L 10 0 L 10 10");
    const bad = (anchors: { nodeId: string; subpath: number; index: number }[]) =>
      errorOf(() => pathOp(doc, { nodeIds: [b], op: "join", anchors }));
    expect(bad([{ nodeId: b, subpath: 0, index: 1 }])).toMatchObject({ code: "INVALID_PATH" });
    expect(
      bad([
        { nodeId: b, subpath: 0, index: 0 },
        { nodeId: b, subpath: 0, index: 2 },
      ]),
    ).toMatchObject({ code: "INVALID_PATH", message: expect.stringMatching(/two open Endpoints/) });
  });

  it("closes a subpath whose two Endpoints are selected", () => {
    const { doc, ids } = paths("M 0 0 L 10 0 L 10 10");
    const [a] = ids as [string];
    pathOp(doc, {
      nodeIds: ids,
      op: "join",
      anchors: [
        { nodeId: a, subpath: 0, index: 2 },
        { nodeId: a, subpath: 0, index: 0 },
      ],
    });
    expect(dOf(doc, a)).toBe("M 0 0 L 10 0 L 10 10 Z");
  });

  it("measures tolerance in document units, and refuses to close a Stray Point", () => {
    const { doc, ids } = paths("M 0 0 L 10 0 L 0 0.5");
    const [a] = ids as [string];
    doc.nodes.set(a, { ...(doc.nodes.get(a) as PathNode), transform: [4, 0, 0, 4, 0, 0] });
    pathOp(doc, { nodeIds: ids, op: "join", tolerance: 1 });
    expect(dOf(doc, a)).toBe("M 0 0 L 10 0 L 0 0.5 Z");
    const dot = paths("M 5 5");
    expect(errorOf(() => pathOp(dot.doc, { nodeIds: dot.ids, op: "join" }))).toMatchObject({
      code: "INVALID_PATH",
    });
  });

  it("refuses paths without an open subpath", () => {
    const { doc, ids } = paths("M 0 0 L 10 0 L 10 10 Z");
    expect(errorOf(() => pathOp(doc, { nodeIds: ids, op: "join" }))).toMatchObject({
      code: "INVALID_PATH",
    });
  });
});

describe("pathOp average", () => {
  it("stacks three Anchors at their centroid, Handles moving along", () => {
    const { doc, node } = setup("M 0 0 L 30 0 C 30 10 60 10 60 30");
    pathOp(doc, {
      nodeIds: [node.id],
      op: "average",
      anchors: [
        { nodeId: node.id, subpath: 0, index: 0 },
        { nodeId: node.id, subpath: 0, index: 1 },
        { nodeId: node.id, subpath: 0, index: 2 },
      ],
    });
    expect((doc.nodes.get(node.id) as PathNode).d).toBe("M 30 10 L 30 10 C 30 20 30 -10 30 10");
  });

  it("averages one axis, across paths in document coordinates, all Anchors without a list", () => {
    const { doc, defaultLayerId, node } = setup("M 0 0 L 10 10");
    const [other] = createNodes(doc, [
      { type: "path", parentId: defaultLayerId, d: "M 0 0" },
    ]).nodes;
    if (!other) throw new Error("setup");
    doc.nodes.set(other.id, { ...other, transform: [1, 0, 0, 1, 0, 40] });
    pathOp(doc, { nodeIds: [node.id, other.id], op: "average", axis: "horizontal" });
    // Horizontal: every Anchor on one horizontal line, at the mean y of 0, 10 and 40.
    expect((doc.nodes.get(node.id) as PathNode).d).toBe("M 0 16.667 L 10 16.667");
    expect((doc.nodes.get(other.id) as PathNode).d).toBe("M 0 -23.333");
    pathOp(doc, { nodeIds: [node.id], op: "average", axis: "vertical" });
    expect((doc.nodes.get(node.id) as PathNode).d).toBe("M 5 16.667 L 5 16.667");
  });
});
