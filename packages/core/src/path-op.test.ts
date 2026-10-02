import { describe, expect, it } from "vitest";
import { loadGeometry } from "../../geometry/src/index.ts";
import type { PathNode } from "./anchor.ts";
import { toAnchors } from "./anchor.ts";
import { childrenOf, createDocument, createNodes } from "./document.ts";
import { KalamoError } from "./errors.ts";
import { formatPath, parsePath, pathBounds, type Segment, shapeSegments } from "./path.ts";
import {
  closestEnds,
  convertToPath,
  type Filled,
  type Geometry,
  type OffsetStyle,
  pathOp,
  type StrokeStyle,
} from "./path-op.ts";
import type { GroupNode, Node, ShapeNode } from "./schema.ts";

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof KalamoError) return e.data;
    throw e;
  }
  throw new Error("expected a KalamoError");
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

  it("turns a spiral into the open path it draws", () => {
    const { doc, defaultLayerId: parentId } = setup("M 0 0");
    const spiral = { type: "spiral", parentId, cx: 5, cy: 5, radius: 20 } as const;
    const [node] = createNodes(doc, [spiral]).nodes;
    if (!node) throw new Error("no spiral");
    const [path] = convertToPath(doc, [node.id]).updated;
    expect(path).toMatchObject({ type: "path", d: formatPath(shapeSegments(node as ShapeNode)) });
    expect(path).not.toHaveProperty("revolution");
    expect((path as { d: string }).d).not.toContain("Z");
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

describe("pathOp outline_stroke", () => {
  /** Outlines every Stroke as a square of its width, recording what it was asked. */
  const stub = () => {
    const calls: { d: string; stroke: StrokeStyle }[] = [];
    const geometry: Geometry = {
      outlineStroke(segments, stroke) {
        calls.push({ d: formatPath(segments), stroke });
        const w = stroke.width;
        return parsePath(`M 0 0 L ${w} 0 L ${w} ${w} Z`, "d");
      },
      offsetPath: () => [],
      divide: () => ({ inside: [], outside: [] }),
      combine: () => [],
    };
    return { calls, geometry };
  };
  const stroked = (appearance: object, extra: Partial<PathNode> = {}) => {
    const { doc, defaultLayerId } = setup("M 0 0");
    const [made] = createNodes(doc, [
      { type: "path", parentId: defaultLayerId, d: "M 0 0 L 100 0", appearance },
    ]).nodes as [PathNode];
    const node = { ...made, ...extra };
    doc.nodes.set(node.id, node);
    return { doc, node, defaultLayerId };
  };

  it("turns a path with one Stroke and no Fill into the Stroke's outline, keeping its id", () => {
    const { doc, node } = stroked({
      strokes: [{ color: "#FF0000", width: 10, cap: "round", join: "bevel", dash: [4, 2] }],
    });
    const { calls, geometry } = stub();
    const result = pathOp(doc, { nodeIds: [node.id], op: "outline_stroke" }, geometry);
    expect(calls).toEqual([
      {
        d: "M 0 0 L 100 0",
        stroke: { width: 10, cap: "round", join: "bevel", miterLimit: 10, dash: [4, 2] },
      },
    ]);
    const outlined = { ...node, d: "M 0 0 L 10 0 L 10 10 Z", fillRule: "nonzero" };
    expect(result).toEqual({
      created: [],
      updated: [
        { ...outlined, appearance: { fills: [{ type: "solid", color: "#FF0000" }], strokes: [] } },
      ],
      deletedIds: [],
      warnings: [],
    });
    expect(doc.nodes.get(node.id)).toEqual(result.updated[0]);
  });

  it("groups a filled path below its outlined Stroke; the Group takes its place and opacity", () => {
    const { doc, node, defaultLayerId } = stroked(
      { fills: [{ color: "#00FF00" }], strokes: [{ color: "#0000FF", width: 4 }] },
      { opacity: 0.5, blendMode: "multiply", name: "Leaf" },
    );
    const result = pathOp(doc, { nodeIds: [node.id], op: "outline_stroke" }, stub().geometry);
    const [group, outline] = result.created as [GroupNode, PathNode];
    expect(group).toMatchObject({
      type: "group",
      parentId: defaultLayerId,
      index: node.index,
      opacity: 0.5,
      blendMode: "multiply",
    });
    const [fill] = result.updated as [PathNode];
    expect(fill).toMatchObject({
      id: node.id,
      name: "Leaf",
      parentId: group.id,
      opacity: 1,
      blendMode: "normal",
      d: node.d,
      appearance: { fills: [{ type: "solid", color: "#00FF00" }], strokes: [] },
    });
    expect(outline).toMatchObject({
      type: "path",
      parentId: group.id,
      opacity: 1,
      d: "M 0 0 L 4 0 L 4 4 Z",
      appearance: { fills: [{ type: "solid", color: "#0000FF" }], strokes: [] },
    });
    expect(outline.id).not.toBe(node.id);
    expect(childrenOf(doc, group.id).map((n) => n.id)).toEqual([node.id, outline.id]);
    const layer = childrenOf(doc, defaultLayerId).map((n) => n.id);
    expect(layer).toContain(group.id);
    expect(layer).not.toContain(node.id);
  });

  it("outlines each of several Strokes in its own path, bottom to top, and converts a Live Shape", () => {
    const { doc, defaultLayerId } = setup("M 0 0");
    const [rect] = createNodes(doc, [
      {
        type: "rect",
        parentId: defaultLayerId,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        appearance: {
          strokes: [
            { color: "#000000", width: 3 },
            { color: "#FFFFFF", width: 1 },
          ],
        },
      },
    ]).nodes as [Node];
    const { calls, geometry } = stub();
    const result = pathOp(doc, { nodeIds: [rect.id], op: "outline_stroke" }, geometry);
    expect(calls.map((c) => c.d)).toEqual([
      "M 0 0 L 10 0 L 10 10 L 0 10 Z",
      "M 0 0 L 10 0 L 10 10 L 0 10 Z",
    ]);
    const [group] = result.created as [GroupNode];
    const children = childrenOf(doc, group.id) as PathNode[];
    expect(children.map((n) => [n.id === rect.id, n.type, n.appearance.fills])).toEqual([
      [true, "path", [{ type: "solid", color: "#000000" }]],
      [false, "path", [{ type: "solid", color: "#FFFFFF" }]],
    ]);
    expect(result.warnings).toMatchObject([{ code: "CONVERTED_TO_PATH", nodeId: rect.id }]);
  });

  it("leaves a path without a Stroke as it is, and refuses when none has one", () => {
    const { doc, node } = stroked({ strokes: [{ color: "#000000" }] });
    const [bare] = createNodes(doc, [
      { type: "path", parentId: node.parentId as string, d: "M 0 0 L 1 1", appearance: {} },
    ]).nodes as [PathNode];
    const result = pathOp(
      doc,
      { nodeIds: [bare.id, node.id], op: "outline_stroke" },
      stub().geometry,
    );
    expect(result.updated.map((n) => n.id)).toEqual([node.id]);
    expect(doc.nodes.get(bare.id)).toBe(bare);
    expect(
      errorOf(() => pathOp(doc, { nodeIds: [bare.id], op: "outline_stroke" }, stub().geometry)),
    ).toMatchObject({ code: "INVALID_PATH", path: "nodeIds" });
  });
});

describe("pathOp offset", () => {
  /** Offsets by moving every point `distance` along x, recording what it was asked. */
  const stub = (empty: string[] = []) => {
    const calls: { d: string; style: OffsetStyle }[] = [];
    const geometry: Geometry = {
      outlineStroke: () => [],
      offsetPath(segments, style) {
        const d = formatPath(segments);
        calls.push({ d, style });
        if (empty.includes(d)) return [];
        return segments.map(({ cmd, args }) => ({
          cmd,
          args: args.map((v, k) => (k % 2 ? v : v + style.distance)),
        }));
      },
      divide: () => ({ inside: [], outside: [] }),
      combine: () => [],
    };
    return { calls, geometry };
  };

  it("adds an offset copy directly below each path and keeps the original", () => {
    const { doc, defaultLayerId } = setup("M 0 0");
    const [a, b] = createNodes(doc, [
      {
        type: "path",
        parentId: defaultLayerId,
        d: "M 0 0 L 100 0 L 100 100 Z",
        appearance: { fills: [{ color: "#FF0000" }] },
        name: "Tri",
      },
      { type: "path", parentId: defaultLayerId, d: "M 10 10 L 20 10 L 20 20 Z" },
    ]).nodes as [PathNode, PathNode];
    const { calls, geometry } = stub();
    const input = { nodeIds: [a.id, b.id], op: "offset" as const, distance: 10 };
    const result = pathOp(doc, input, geometry);
    expect(calls.map((c) => c.style)).toEqual([
      { distance: 10, join: "miter", miterLimit: 4, fillRule: "nonzero" },
      { distance: 10, join: "miter", miterLimit: 4, fillRule: "nonzero" },
    ]);
    expect(result).toMatchObject({ updated: [], deletedIds: [], warnings: [] });
    const [ca, cb] = result.created as [PathNode, PathNode];
    expect(ca).toEqual({
      ...a,
      id: ca.id,
      index: ca.index,
      d: "M 10 0 L 110 0 L 110 100 Z",
      fillRule: "evenodd",
    });
    expect(cb.d).toBe("M 20 10 L 30 10 L 30 20 Z");
    expect(doc.nodes.get(a.id)).toBe(a);
    const order = childrenOf(doc, defaultLayerId).map((n) => n.id);
    expect(order.slice(1)).toEqual([ca.id, a.id, cb.id, b.id]);
  });

  it("offsets in document units and keeps a Live Shape live, its copy a path", () => {
    const { doc, defaultLayerId } = setup("M 0 0");
    const [made] = createNodes(doc, [
      { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 10, height: 10 },
    ]).nodes as [Node];
    const rect = { ...made, transform: [2, 0, 0, 2, 5, 0] } as Node;
    doc.nodes.set(rect.id, rect);
    const { calls, geometry } = stub();
    const input = {
      nodeIds: [rect.id],
      op: "offset" as const,
      distance: -4,
      join: "round" as const,
    };
    const [copy] = pathOp(doc, input, geometry).created as [PathNode];
    expect(calls[0]).toMatchObject({
      d: "M 5 0 L 25 0 L 25 20 L 5 20 Z",
      style: { distance: -4, join: "round" },
    });
    // Back in the shape's own units: 4 pt at scale 2 is 2.
    expect(copy).toMatchObject({ type: "path", d: "M -2 0 L 8 0 L 8 10 L -2 10 Z" });
    expect(copy.transform).toEqual(rect.transform);
    expect(doc.nodes.get(rect.id)).toBe(rect);
  });

  it("skips a path that shrinks away or clips, and refuses when nothing is left", () => {
    const { doc, node } = setup("M 0 0 L 1 0 L 1 1 Z");
    const { geometry } = stub([formatPath(parsePath("M 0 0 L 1 0 L 1 1 Z", "d"))]);
    const input = { nodeIds: [node.id], op: "offset" as const, distance: -5 };
    expect(errorOf(() => pathOp(doc, input, geometry))).toMatchObject({
      code: "INVALID_PATH",
      path: "nodeIds",
    });
    doc.nodes.set(node.id, { ...node, clipping: true } as Node);
    expect(errorOf(() => pathOp(doc, { ...input, distance: 5 }, geometry))).toMatchObject({
      code: "INVALID_PATH",
    });
  });

  it("needs a distance", () => {
    const { doc, node } = setup("M 0 0 L 1 0 L 1 1 Z");
    expect(
      errorOf(() => pathOp(doc, { nodeIds: [node.id], op: "offset" }, stub().geometry)),
    ).toMatchObject({ code: "INVALID_PATH", path: "distance" });
  });
});

describe("pathOp divide_below", () => {
  /** The inside is the cutter, the outside the target unless it is in `within`. */
  const stub = (within: string[] = []) => {
    const calls: { target: Filled; cutter: Filled }[] = [];
    const geometry: Geometry = {
      outlineStroke: () => [],
      offsetPath: () => [],
      divide(target, cutter) {
        calls.push({ target, cutter });
        const inner = within.includes(formatPath(target.segments));
        return { inside: cutter.segments, outside: inner ? [] : target.segments };
      },
      combine: () => [],
    };
    return { calls, geometry };
  };
  const red = { fills: [{ color: "#FF0000" }] };

  it("cuts each filled shape below that it overlaps in two and deletes the cutter", () => {
    const { doc, node: under, defaultLayerId: layer } = setup("M 0 0 L 100 0 L 100 100 Z");
    const [square, cutter, over] = createNodes(doc, [
      { type: "rect", parentId: layer, x: 0, y: 0, width: 100, height: 100, appearance: red },
      { type: "ellipse", parentId: layer, x: 20, y: 20, width: 60, height: 60 },
      { type: "rect", parentId: layer, x: 0, y: 0, width: 100, height: 100, appearance: red },
    ]).nodes as [Node, Node, Node];
    doc.nodes.set(under.id, { ...under, locked: true } as Node);
    const { calls, geometry } = stub();
    const result = pathOp(doc, { nodeIds: [cutter.id], op: "divide_below" }, geometry);
    expect(calls).toHaveLength(1);
    expect(result.deletedIds).toEqual([cutter.id]);
    expect(doc.nodes.has(cutter.id)).toBe(false);
    const [outside] = result.updated as [PathNode];
    const [inside] = result.created as [PathNode];
    expect(outside).toMatchObject({
      id: square.id,
      type: "path",
      d: "M 0 0 L 100 0 L 100 100 L 0 100 Z",
      fillRule: "evenodd",
      appearance: { fills: [{ color: "#FF0000" }] },
    });
    expect(inside).toMatchObject({ type: "path", appearance: { fills: [{ color: "#FF0000" }] } });
    expect(inside.d).toBe(formatPath(calls[0]?.cutter.segments ?? []));
    expect(result.warnings).toMatchObject([{ code: "CONVERTED_TO_PATH" }]);
    const order = childrenOf(doc, layer).map((n) => n.id);
    expect(order).toEqual([under.id, square.id, inside.id, over.id]);
  });

  it("cuts in document coordinates and leaves unfilled, clipping and distant shapes", () => {
    const { doc, defaultLayerId: layer } = setup("M 0 0 L 1 0 L 1 1 Z");
    const [scaled, bare, clip, far, cutter] = createNodes(doc, [
      { type: "path", parentId: layer, d: "M 0 0 L 10 0 L 10 10 Z", appearance: red },
      { type: "path", parentId: layer, d: "M 0 0 L 10 0 L 10 10 Z", appearance: {} },
      { type: "path", parentId: layer, d: "M 0 0 L 10 0 L 10 10 Z", appearance: red },
      { type: "path", parentId: layer, d: "M 500 0 L 510 0 L 510 10 Z", appearance: red },
      { type: "path", parentId: layer, d: "M 5 5 L 15 5 L 15 15 Z" },
    ]).nodes as [PathNode, Node, Node, Node, Node];
    doc.nodes.set(scaled.id, { ...scaled, transform: [2, 0, 0, 2, 0, 0] });
    doc.nodes.set(clip.id, { ...clip, clipping: true } as Node);
    const kept = [bare, clip, far].map((n) => doc.nodes.get(n.id));
    const { calls, geometry } = stub([formatPath(parsePath("M 0 0 L 20 0 L 20 20 Z", "d"))]);
    const result = pathOp(doc, { nodeIds: [cutter.id], op: "divide_below" }, geometry);
    expect(calls.map((c) => formatPath(c.target.segments))).toEqual(["M 0 0 L 20 0 L 20 20 Z"]);
    // Wholly inside, the path is its inside piece, back in its own units.
    expect(result.created).toEqual([]);
    expect(result.updated).toMatchObject([{ id: scaled.id, d: "M 2.5 2.5 L 7.5 2.5 L 7.5 7.5 Z" }]);
    expect([bare, clip, far].map((n) => doc.nodes.get(n.id))).toEqual(kept);
  });

  it("takes one cutter and fails when it overlaps nothing below", () => {
    const { doc, node, defaultLayerId: layer } = setup("M 0 0 L 1 0 L 1 1 Z");
    const [other] = createNodes(doc, [
      { type: "path", parentId: layer, d: "M 50 50 L 60 50 L 60 60 Z" },
    ]).nodes as [Node];
    const { geometry } = stub();
    const both = { nodeIds: [node.id, other.id], op: "divide_below" as const };
    expect(errorOf(() => pathOp(doc, both, geometry))).toMatchObject({ path: "nodeIds" });
    const one = { nodeIds: [other.id], op: "divide_below" as const };
    expect(errorOf(() => pathOp(doc, one, geometry))).toMatchObject({ code: "INVALID_PATH" });
    doc.nodes.set(node.id, { ...node, locked: true } as Node);
    const locked = { nodeIds: [node.id], op: "divide_below" as const };
    expect(errorOf(() => pathOp(doc, locked, geometry))).toMatchObject({ path: "nodeIds" });
    expect(doc.nodes.has(other.id)).toBe(true);
  });
});

describe("pathOp Shape Modes, on real PathKit (ADR-0104)", () => {
  const scene = () => {
    const { doc, defaultLayerId: layer } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const child = (x: number, y: number, w: number, h: number, color = "#FF0000") => ({
      type: "rect" as const,
      ...{ x, y, width: w, height: h, appearance: { fills: [{ color }] } },
    });
    const box = (...args: Parameters<typeof child>) => ({ ...child(...args), parentId: layer });
    return { doc, layer, box, child };
  };
  /** Each subpath's signed area, for straight-sided results. */
  const areas = (d: string) =>
    toAnchors(parsePath(d, "d")).map(({ anchors }) =>
      anchors.reduce((sum, { anchor: [x, y] }, i) => {
        const [nx, ny] = (anchors[(i + 1) % anchors.length] as (typeof anchors)[0]).anchor;
        return sum + (x * ny - nx * y) / 2;
      }, 0),
    );
  const total = (d: string) => areas(d).reduce((a, b) => a + Math.abs(b), 0);
  const run = async (doc: ReturnType<typeof scene>["doc"], nodeIds: string[], op: string) =>
    pathOp(doc, { nodeIds, op } as never, await loadGeometry());

  it("unites, subtracts, intersects and excludes two overlapping rects", async () => {
    const result = async (op: string) => {
      const { doc, box } = scene();
      const ids = createNodes(doc, [box(0, 0, 20, 20), box(10, 10, 20, 20)]).nodes.map((n) => n.id);
      const [made] = (await run(doc, ids, op)).created as [PathNode];
      return { ...made, bounds: pathBounds(parsePath(made.d, "d")), area: total(made.d) };
    };
    expect(await result("unite")).toMatchObject({
      fillRule: "nonzero",
      area: 700,
      bounds: { x: 0, y: 0, width: 30, height: 30 },
    });
    expect(await result("minus_front")).toMatchObject({
      area: 300,
      bounds: { x: 0, y: 0, width: 20, height: 20 },
    });
    expect(await result("intersect")).toMatchObject({
      area: 100,
      bounds: { x: 10, y: 10, width: 10, height: 10 },
    });
    // The union's outline and the overlap as an evenodd hole.
    const exclude = await result("exclude");
    expect(exclude.fillRule).toBe("evenodd");
    expect(
      areas(exclude.d)
        .map(Math.abs)
        .sort((a, b) => a - b),
    ).toEqual([100, 700]);
  });

  it("winds a hole against its outline, so nonzero leaves it empty", async () => {
    const { doc, box } = scene();
    const ids = createNodes(doc, [box(0, 0, 30, 30), box(10, 10, 10, 10)]).nodes.map((n) => n.id);
    const [ring] = (await run(doc, ids, "minus_front")).created as [PathNode];
    const [outer = 0, hole = 0] = areas(ring.d);
    expect([Math.abs(outer), Math.abs(hole)]).toEqual([900, 100]);
    expect(Math.sign(outer)).toBe(-Math.sign(hole));
  });

  it("minus_front keeps the backmost's paint, name and place, and deletes every operand", async () => {
    const { doc, layer, box } = scene();
    const [under, back, a, b, over] = createNodes(doc, [
      box(0, 0, 5, 5),
      { ...box(0, 0, 40, 20, "#00FF00"), name: "back" },
      box(0, 0, 10, 20),
      box(30, 0, 10, 20),
      box(0, 0, 5, 5),
    ]).nodes as [Node, Node, Node, Node, Node];
    doc.nodes.set(back.id, { ...back, opacity: 0.5 });
    const out = await run(doc, [b.id, back.id, a.id], "minus_front");
    const [made] = out.created as [PathNode];
    expect(made).toMatchObject({
      name: "back",
      opacity: 0.5,
      parentId: layer,
      index: back.index,
      appearance: { fills: [{ color: "#00FF00" }] },
    });
    expect(total(made.d)).toBe(400);
    expect(out.deletedIds.sort()).toEqual([back.id, a.id, b.id].sort());
    expect(childrenOf(doc, layer).map((n) => n.id)).toEqual([under.id, made.id, over.id]);
  });

  it("unite takes the topmost's paint and place, in a Group, in its coordinates", async () => {
    const { doc, layer, child } = scene();
    const [group] = createNodes(doc, [
      {
        type: "group",
        parentId: layer,
        children: [child(0, 0, 10, 10), child(5, 0, 10, 10, "#0000FF")],
      },
    ]).nodes as [GroupNode];
    const [a, b] = childrenOf(doc, group.id) as [Node, Node];
    const [made] = (await run(doc, [b.id, a.id], "unite")).created as [PathNode];
    expect(made).toMatchObject({
      parentId: group.id,
      index: b.index,
      transform: [1, 0, 0, 1, 0, 0],
    });
    expect(made.appearance.fills).toMatchObject([{ color: "#0000FF" }]);
    expect(pathBounds(parsePath(made.d, "d"))).toEqual({ x: 0, y: 0, width: 15, height: 10 });
  });

  it("places a rotated rect and a Live Ellipse by their transforms, baking the Stroke", async () => {
    const { doc, layer, box } = scene();
    // The rect on top, so the result takes its Stroke.
    const [ellipse, rect] = createNodes(doc, [
      { type: "ellipse", parentId: layer, x: 0, y: 0, width: 10, height: 10 },
      { ...box(0, 0, 20, 10), appearance: { strokes: [{ color: "#000000", width: 1 }] } },
    ]).nodes as [PathNode, PathNode];
    // A quarter turn about the origin at twice the size, moved right: x 80..100, y 0..40.
    doc.nodes.set(rect.id, { ...rect, transform: [0, 2, -2, 0, 100, 0] });
    doc.nodes.set(ellipse.id, { ...ellipse, transform: [1, 0, 0, 1, 95, 15] });
    const [made] = (await run(doc, [ellipse.id, rect.id], "intersect")).created as [PathNode];
    const b = pathBounds(parsePath(made.d, "d"));
    expect(b).toMatchObject({ x: 95, y: 15, width: 5 });
    expect(b?.height).toBeCloseTo(10, 2);
    expect(made.appearance.strokes).toMatchObject([{ width: 2 }]);
  });

  it("counts a Group as the union of its leaves", async () => {
    const { doc, layer, box, child } = scene();
    const [back, group] = createNodes(doc, [
      box(0, 0, 40, 20),
      { type: "group", parentId: layer, children: [child(0, 0, 20, 20), child(10, 0, 20, 20)] },
    ]).nodes as [Node, GroupNode];
    const inside = childrenOf(doc, group.id).map((n) => n.id);
    const out = await run(doc, [back.id, group.id], "minus_front");
    // As two operands, the leaves' overlap would come back.
    const [made] = out.created as [PathNode];
    expect(total(made.d)).toBe(200);
    expect(out.deletedIds.sort()).toEqual([back.id, group.id, ...inside].sort());
  });

  it("leaves a Group's Opacity Mask out of its operand, area and paint", async () => {
    const result = async (op: string) => {
      const { doc, layer, box, child } = scene();
      const [back, group] = createNodes(doc, [
        box(0, 0, 40, 20),
        {
          type: "group",
          parentId: layer,
          children: [child(0, 0, 10, 20, "#0000FF"), child(0, 0, 40, 20, "#000000")],
        },
      ]).nodes as [Node, GroupNode];
      const [, mask] = childrenOf(doc, group.id) as [Node, Node];
      doc.nodes.set(mask.id, {
        ...mask,
        opacityMask: { clip: true, invert: false, link: true },
      } as Node);
      const [made] = (await run(doc, [back.id, group.id], op)).created as [PathNode];
      return { area: total(made.d), fills: made.appearance.fills };
    };
    expect(await result("minus_front")).toMatchObject({ area: 600 });
    expect(await result("unite")).toMatchObject({ fills: [{ color: "#0000FF" }] });
  });

  it("counts a Node inside a Group operand once, as part of the Group", async () => {
    const { doc, layer, box, child } = scene();
    const [back, group] = createNodes(doc, [
      box(-5, 0, 10, 10),
      { type: "group", parentId: layer, children: [child(0, 0, 10, 10), child(5, 0, 10, 10)] },
    ]).nodes as [Node, GroupNode];
    const [inner] = childrenOf(doc, group.id) as [Node];
    const out = await run(doc, [group.id, inner.id, back.id], "exclude");
    const [made] = out.created as [PathNode];
    // Above the Group's place in the Layer, not in the deleted Group.
    expect(made).toMatchObject({ parentId: layer, index: group.index });
    expect(childrenOf(doc, layer).map((n) => n.id)).toEqual([made.id]);
    // The overlap of back and Group, -5..15 minus 0..5; as a third operand, inner would toggle 0..10.
    expect(total(made.d)).toBe(150);
    expect(out.warnings).toEqual([
      expect.objectContaining({ code: "NESTED_TARGET", nodeId: inner.id }),
    ]);
  });

  it("refuses a text, one operand and an empty result, changing nothing", async () => {
    const { doc, layer, box } = scene();
    const [a, text, far, cover] = createNodes(doc, [
      box(0, 0, 10, 10),
      { type: "text", parentId: layer, x: 0, y: 0, content: "Hi" },
      box(50, 50, 10, 10),
      box(-5, -5, 20, 20),
    ]).nodes as [Node, Node, Node, Node];
    const before = structuredClone(doc.nodes);
    const fails = async (ids: string[], op = "unite") => {
      const geometry = await loadGeometry();
      return errorOf(() => pathOp(doc, { nodeIds: ids, op } as never, geometry));
    };
    expect(await fails([a.id, text.id])).toMatchObject({
      code: "INVALID_PATH",
      path: "nodeIds[1]",
      hint: expect.stringContaining("Create Outlines"),
    });
    expect(await fails([a.id])).toMatchObject({ code: "INVALID_PATH", path: "nodeIds" });
    expect(await fails([a.id, a.id])).toMatchObject({ code: "INVALID_PATH", path: "nodeIds" });
    expect(await fails([a.id, far.id], "intersect")).toMatchObject({
      code: "INVALID_PATH",
      message: "The objects have no area in common.",
    });
    expect(await fails([cover.id, a.id], "minus_front")).toMatchObject({
      message: "The objects in front cover all of the backmost one.",
    });
    expect(await fails([layer, a.id])).toMatchObject({ path: "nodeIds[0]" });
    expect(await fails([a.id, "nope"])).toMatchObject({
      code: "NODE_NOT_FOUND",
      path: "nodeIds[1]",
    });
    expect(doc.nodes).toEqual(before);
  });
});

describe("pathOp clean_up", () => {
  it("removes Stray Points, unpainted objects and blank texts across the Document", () => {
    const { doc, node: stray, defaultLayerId: layer } = setup("M 5 5");
    const [unpainted, mixed, kept, clip, blank, text, locked] = createNodes(doc, [
      { type: "rect", parentId: layer, x: 0, y: 0, width: 10, height: 10, appearance: {} },
      { type: "path", parentId: layer, d: "M 0 0 L 10 0 M 50 50 M 20 0 L 30 0" },
      { type: "rect", parentId: layer, x: 0, y: 0, width: 10, height: 10 },
      { type: "rect", parentId: layer, x: 0, y: 0, width: 10, height: 10, appearance: {} },
      { type: "text", parentId: layer, x: 0, y: 0, content: " \n " },
      { type: "text", parentId: layer, x: 0, y: 0, content: "Hi", appearance: {} },
      { type: "path", parentId: layer, d: "M 1 1" },
    ]).nodes as [Node, Node, Node, Node, Node, Node, Node];
    doc.nodes.set(clip.id, { ...clip, clipping: true } as Node);
    doc.nodes.set(locked.id, { ...locked, locked: true } as Node);
    const result = pathOp(doc, { op: "clean_up" });
    expect(result.deletedIds.sort()).toEqual([stray.id, unpainted.id, blank.id].sort());
    expect(result.updated).toEqual([{ ...mixed, d: "M 0 0 L 10 0 M 20 0 L 30 0" }]);
    for (const n of [kept, clip, text, locked]) expect(doc.nodes.has(n.id)).toBe(true);
    expect(doc.nodes.has(stray.id)).toBe(false);
  });

  it("each checkbox off keeps its kind, and nothing to remove fails", () => {
    const { doc, node: stray, defaultLayerId: layer } = setup("M 5 5");
    createNodes(doc, [
      { type: "rect", parentId: layer, x: 0, y: 0, width: 10, height: 10, appearance: {} },
    ]);
    const input = { op: "clean_up" as const, unpainted: false, emptyText: false };
    expect(pathOp(doc, input).deletedIds).toEqual([stray.id]);
    expect(errorOf(() => pathOp(doc, input))).toMatchObject({ code: "INVALID_PATH" });
  });
});

describe("pathOp split_into_grid", () => {
  it("splits a 200x100 rect 2x3 with 10 pt gutters into six rects in its place", () => {
    const { doc, node: below, defaultLayerId: layer } = setup("M 0 0 L 1 1");
    const [rect, above] = createNodes(doc, [
      {
        type: "rect",
        parentId: layer,
        name: "Box",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        appearance: { fills: [{ color: "#FF0000" }] },
      },
      { type: "path", parentId: layer, d: "M 0 0 L 1 1" },
    ]).nodes as [Node, Node];
    const result = pathOp(doc, {
      nodeIds: [rect.id],
      op: "split_into_grid",
      rows: 2,
      cols: 3,
      gutter: 10,
    });
    expect(result.deletedIds).toEqual([rect.id]);
    const cells = result.created as Extract<Node, { type: "rect" }>[];
    const w = (200 - 20) / 3;
    expect(cells.map((c) => [c.x, c.y, c.width, c.height])).toEqual([
      [0, 0, w, 45],
      [w + 10, 0, w, 45],
      [2 * w + 20, 0, w, 45],
      [0, 55, w, 45],
      [w + 10, 55, w, 45],
      [2 * w + 20, 55, w, 45],
    ]);
    expect(cells[0]).toMatchObject({
      type: "rect",
      name: "Box",
      appearance: (rect as PathNode).appearance,
    });
    const order = childrenOf(doc, layer).map((n) => n.id);
    expect(order).toEqual([below.id, ...cells.map((c) => c.id), above.id]);
  });

  it("takes each shape's document bounds, the topmost's appearance, totals, and skips open paths", () => {
    const { doc, node: open, defaultLayerId: layer } = setup("M 0 0 L 10 10");
    const [made, top] = createNodes(doc, [
      { type: "ellipse", parentId: layer, x: 0, y: 0, width: 10, height: 10 },
      {
        type: "rect",
        parentId: layer,
        x: 100,
        y: 0,
        width: 10,
        height: 10,
        appearance: { fills: [{ color: "#00FF00" }] },
      },
    ]).nodes as [Node, Node];
    doc.nodes.set(made.id, { ...made, transform: [2, 0, 0, 2, 5, 0] } as Node);
    const input = {
      nodeIds: [made.id, open.id, top.id],
      op: "split_into_grid" as const,
      rows: 1,
      cols: 2,
      gutter: 0,
      totalWidth: 30,
    };
    const result = pathOp(doc, input);
    expect(result.deletedIds).toEqual([made.id, top.id]);
    expect(result.created?.map((c) => c.type === "rect" && [c.x, c.y, c.width, c.height])).toEqual([
      [5, 0, 15, 20],
      [20, 0, 15, 20],
      [100, 0, 15, 10],
      [115, 0, 15, 10],
    ]);
    for (const c of result.created ?? []) {
      expect(c).toMatchObject({ appearance: (top as PathNode).appearance });
    }
    expect(result.created?.[0]?.transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(
      errorOf(() => pathOp(doc, { nodeIds: [open.id], op: "split_into_grid", rows: 2, cols: 2 })),
    ).toMatchObject({ code: "INVALID_PATH", path: "nodeIds" });
  });

  it("splits the bench's 490 pt square 10x10 with 10 pt gutters into its 40 pt grid", () => {
    const { doc, defaultLayerId: layer } = setup("M 0 0");
    const [rect] = createNodes(doc, [
      { type: "rect", parentId: layer, x: 50, y: 50, width: 490, height: 490 },
    ]).nodes as [Node];
    const input = {
      nodeIds: [rect.id],
      op: "split_into_grid" as const,
      rows: 10,
      cols: 10,
      gutter: 10,
    };
    const cells = pathOp(doc, input).created as Extract<Node, { type: "rect" }>[];
    const at = Array.from({ length: 10 }, (_, k) => 50 + 50 * k);
    expect(cells.map((c) => [c.x, c.y, c.width, c.height])).toEqual(
      at.flatMap((y) => at.map((x) => [x, y, 40, 40])),
    );
    for (const c of cells) expect(c.transform).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("refuses gutters that leave no room", () => {
    const { doc, defaultLayerId: layer } = setup("M 0 0");
    const [rect] = createNodes(doc, [
      { type: "rect", parentId: layer, x: 0, y: 0, width: 20, height: 20 },
    ]).nodes as [Node];
    const input = {
      nodeIds: [rect.id],
      op: "split_into_grid" as const,
      rows: 3,
      cols: 1,
      gutter: 10,
    };
    expect(errorOf(() => pathOp(doc, input))).toMatchObject({
      code: "INVALID_PATH",
      path: "gutter",
    });
  });
});
