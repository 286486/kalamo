import { describe, expect, it } from "vitest";
import type { PathNode } from "./anchor.ts";
import { toAnchors } from "./anchor.ts";
import { createDocument, createNodes } from "./document.ts";
import { ZibelError } from "./errors.ts";
import { parsePath, type Segment } from "./path.ts";
import { closestEnds, convertToPath, pathOp } from "./path-op.ts";

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ZibelError) return e.data;
    throw e;
  }
  throw new Error("expected a ZibelError");
};

const setup = (d: string) => {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const [node] = createNodes(doc, [{ type: "path", parentId: defaultLayerId, d }]).nodes;
  if (!node) throw new Error("setup");
  return { doc, node, defaultLayerId };
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

describe("closestEnds", () => {
  const chains = (...ds: string[]) => ds.flatMap((d) => toAnchors(parsePath(d, "d")));

  it("finds the closest pair of Endpoints across every pair of subpaths", () => {
    // The first and third subpaths' starts are 1 apart; every other pair is farther.
    const found = closestEnds(chains("M 0 0 L 10 0", "M 50 0 L 60 0", "M 0 1 L -10 1"));
    expect(found).toMatchObject({ i: 0, j: 2, aEnd: false, bEnd: false, dist: 1 });
  });

  it("tells the end from the start on both sides", () => {
    const found = closestEnds(chains("M 0 0 L 10 0", "M 30 0 L 12 0"));
    expect(found).toMatchObject({ i: 0, j: 1, aEnd: true, bEnd: true, dist: 2 });
  });

  it("keeps the first pair on a tie", () => {
    const found = closestEnds(chains("M 0 0 L 10 0", "M 11 0 L 20 0", "M -1 0 L -5 0"));
    expect(found).toMatchObject({ i: 0, j: 1, aEnd: true, bEnd: false, dist: 1 });
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

describe("pathOp simplify", () => {
  const subpathsOf = (doc: ReturnType<typeof setup>["doc"], id: string) =>
    toAnchors(parsePath((doc.nodes.get(id) as PathNode).d, "d"));
  /** The farthest a point lies from the drawn outline of `d`. */
  const strays = (points: number[][], d: string) => {
    const curve = pieces(d).flatMap((p) => Array.from({ length: 201 }, (_, k) => at(p, k / 200)));
    return Math.max(
      ...points.map((p) =>
        Math.min(
          ...curve.map((q) => Math.hypot((p[0] ?? 0) - (q[0] ?? 0), (p[1] ?? 0) - (q[1] ?? 0))),
        ),
      ),
    );
  };
  // A 200-Anchor Pencil path at Accurate over a slightly shaky sine.
  const shaky = Array.from({ length: 200 }, (_, i) => [
    i * 2,
    50 + 30 * Math.sin(i / 15) + 0.2 * Math.sin(i * 2.3),
  ]);
  const pencil = `M ${shaky.map((p) => p.join(" ")).join(" L ")}`;

  it("refits a 200-Anchor path with far fewer Anchors, within the default 1 pt", () => {
    const { doc, node } = setup(pencil);
    pathOp(doc, { nodeIds: [node.id], op: "simplify" });
    const [s] = subpathsOf(doc, node.id);
    expect(s?.closed).toBe(false);
    expect(s?.anchors.length).toBeLessThan(20);
    expect(s?.anchors[0]?.anchor).toEqual(shaky[0]);
    expect(strays(shaky, (doc.nodes.get(node.id) as PathNode).d)).toBeLessThanOrEqual(1.01);
  });

  it("toLines gives only straight segments, within the tolerance", () => {
    const { doc, node } = setup(pencil);
    pathOp(doc, { nodeIds: [node.id], op: "simplify", tolerance: 0.5, toLines: true });
    const d = (doc.nodes.get(node.id) as PathNode).d;
    expect(new Set(parsePath(d, "d").map((s) => s.cmd))).toEqual(new Set(["M", "L"]));
    expect(parsePath(d, "d").length).toBeLessThan(60);
    expect(strays(shaky, d)).toBeLessThanOrEqual(0.51);
  });

  it("keeps a closed subpath closed, its corners as Corner Anchors", () => {
    const { doc, node } = setup("M 0 0 L 40 0 L 40 40 L 0 40 Z");
    for (let k = 0; k < 3; k++) pathOp(doc, { nodeIds: [node.id], op: "add_anchors" });
    expect(subpathsOf(doc, node.id)[0]?.anchors.length).toBe(32);
    pathOp(doc, { nodeIds: [node.id], op: "simplify" });
    const [s] = subpathsOf(doc, node.id);
    expect(s?.closed).toBe(true);
    expect(s?.anchors.map((a) => a.anchor).sort()).toEqual(
      [
        [0, 0],
        [0, 40],
        [40, 0],
        [40, 40],
      ].sort(),
    );
  });

  it("keeps a turn as a Corner only when its angle is at most cornerAngle", () => {
    // Two lines meeting at 120°, each with Anchors along it.
    const d = "M 0 0 L 25 0 L 50 0 L 62.5 21.651 L 75 43.301";
    const tip = (cornerAngle?: number) => {
      const { doc, node } = setup(d);
      pathOp(doc, { nodeIds: [node.id], op: "simplify", cornerAngle });
      return subpathsOf(doc, node.id)[0]?.anchors.find(
        (a) => Math.hypot(a.anchor[0] - 50, a.anchor[1]) < 1e-9 && a.type === "corner",
      );
    };
    expect(tip()).toBeUndefined();
    expect(tip(150)).toBeDefined();
  });

  it("makes Corners of original Anchors only: at 180, Smooth ones stay Smooth", () => {
    const { doc, node } = setup(pencil);
    pathOp(doc, { nodeIds: [node.id], op: "simplify" });
    pathOp(doc, { nodeIds: [node.id], op: "add_anchors" });
    const before = subpathsOf(doc, node.id)[0]?.anchors ?? [];
    expect(before.slice(1, -1).every((a) => a.type === "smooth")).toBe(true);
    pathOp(doc, { nodeIds: [node.id], op: "simplify", cornerAngle: 180 });
    const after = subpathsOf(doc, node.id)[0]?.anchors ?? [];
    expect(after.length).toBeLessThanOrEqual(before.length);
    expect(after.slice(1, -1).every((a) => a.type === "smooth")).toBe(true);
  });

  it("toLines keeps only original Anchors", () => {
    const { doc, node } = setup(pencil);
    pathOp(doc, { nodeIds: [node.id], op: "simplify", toLines: true });
    const kept = subpathsOf(doc, node.id)[0]?.anchors.map((a) => a.anchor) ?? [];
    const rounded = shaky.map((p) => p.map((v) => Math.round(v * 1e3) / 1e3).join(" "));
    expect(kept.every((p) => rounded.includes(p.join(" ")))).toBe(true);
  });

  it("measures the tolerance in document units", () => {
    const { doc, node } = setup(pencil);
    doc.nodes.set(node.id, { ...node, transform: [10, 0, 0, 10, 0, 0] });
    pathOp(doc, { nodeIds: [node.id], op: "simplify", tolerance: 10, toLines: true });
    expect(strays(shaky, (doc.nodes.get(node.id) as PathNode).d)).toBeLessThanOrEqual(1.01);
  });
});
