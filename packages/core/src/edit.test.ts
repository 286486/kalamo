import { describe, expect, it } from "vitest";
import {
  bounds,
  childrenOf,
  clippingPath,
  createDocument,
  createNodes,
  ellipseMatrix,
  outline,
  paintedLeaves,
} from "./document.ts";
import {
  deleteNodes,
  duplicateNodes,
  reorderNodes,
  reparentNodes,
  transformNodes,
  updateNodes,
} from "./edit.ts";
import { KalamoError } from "./errors.ts";
import { parseDocument, serializeDocument } from "./file.ts";
import { makeMask } from "./mask.ts";
import { applyTo, compose, IDENTITY, invert, transformSegments } from "./matrix.ts";
import { formatPath, parsePath, pathBounds, shapeSegments } from "./path.ts";
import {
  type Document,
  type Gradient,
  type Matrix,
  type Node,
  NodeInput,
  type Rect,
  type ShapeNode,
} from "./schema.ts";
import { areaFrame, type Glyph, glyphs, layoutText, overflowWarnings } from "./text.ts";

const newDoc = () => {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const rect = (x: number, y: number, extra: object = {}) =>
    ({ type: "rect", parentId: defaultLayerId, x, y, width: 50, height: 30, ...extra }) as const;
  return { doc, defaultLayerId, rect };
};

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof KalamoError) return e.data;
    throw e;
  }
  throw new Error("expected a KalamoError");
};

const near = (r: ReturnType<typeof bounds>) =>
  r && Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]));

const shape = (doc: { nodes: Map<string, Node> }, id: string) => doc.nodes.get(id) as ShapeNode;

describe("transformNodes", () => {
  it("rotates a rect about its center, keeping its parameters", () => {
    const { doc, rect } = newDoc();
    const [r] = createNodes(doc, [rect(10, 10)]).nodes;
    if (!r) throw new Error("setup");
    const { nodes } = transformNodes(doc, { nodeIds: [r.id], rotate: 90 });
    expect(nodes.map((n) => n.id)).toEqual([r.id]);
    const after = shape(doc, r.id);
    expect(after).toMatchObject({ x: 10, y: 10, width: 50, height: 30 });
    expect(after.transform).toEqual([0, 1, -1, 0, 60, -10]);
    expect(near(bounds(doc, after))).toEqual({ x: 20, y: 0, width: 30, height: 50 });
  });

  it("pushes a Group's transform down to its leaves (ADR-0007)", () => {
    const { doc, defaultLayerId } = newDoc();
    const [g, a, inner, b] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        children: [
          { type: "rect", x: 0, y: 0, width: 10, height: 10 },
          { type: "group", children: [{ type: "line", x1: 0, y1: 0, x2: 5, y2: 5 }] },
        ],
      },
    ]).nodes;
    if (!g || !a || !inner || !b) throw new Error("setup");
    const { nodes } = transformNodes(doc, { nodeIds: [g.id], translate: { x: 100 } });
    expect(nodes.map((n) => n.id)).toEqual([a.id, b.id]);
    expect(doc.nodes.get(g.id)?.transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(doc.nodes.get(inner.id)?.transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(shape(doc, a.id).transform).toEqual([1, 0, 0, 1, 100, 0]);
    expect(bounds(doc, doc.nodes.get(g.id) as Node)).toEqual({
      x: 100,
      y: 0,
      width: 10,
      height: 10,
    });
  });

  it("turns targets about one shared pivot, or each about its own with each", () => {
    const { doc, rect } = newDoc();
    const [a, b] = createNodes(doc, [rect(0, 0), rect(100, 0)]).nodes;
    if (!a || !b) throw new Error("setup");
    transformNodes(doc, { nodeIds: [a.id, b.id], rotate: 180 });
    expect(near(bounds(doc, shape(doc, a.id)))?.x).toBe(100);
    expect(near(bounds(doc, shape(doc, b.id)))?.x).toBe(0);
    transformNodes(doc, { nodeIds: [a.id, b.id], rotate: 180, each: true });
    expect(near(bounds(doc, shape(doc, a.id)))?.x).toBe(100);
    expect(near(bounds(doc, shape(doc, b.id)))?.x).toBe(0);
  });

  it("uses a named reference point or coordinates as the pivot", () => {
    const { doc, rect } = newDoc();
    const [a] = createNodes(doc, [rect(10, 10)]).nodes;
    if (!a) throw new Error("setup");
    transformNodes(doc, { nodeIds: [a.id], scale: 2, pivot: "topLeft" });
    expect(near(bounds(doc, shape(doc, a.id)))).toEqual({ x: 10, y: 10, width: 100, height: 60 });
    transformNodes(doc, { nodeIds: [a.id], scale: 0.5, pivot: "bottomRight" });
    expect(near(bounds(doc, shape(doc, a.id)))).toEqual({ x: 60, y: 40, width: 50, height: 30 });
    transformNodes(doc, { nodeIds: [a.id], rotate: 90, pivot: { x: 0, y: 0 } });
    expect(near(bounds(doc, shape(doc, a.id)))).toEqual({ x: -70, y: 60, width: 30, height: 50 });
  });

  it("keeps the stored Stroke width unless scaleStrokes is false", () => {
    const { doc, rect } = newDoc();
    const strokes = [{ color: "#000000", width: 2, dash: [4, 2] }];
    const [a, b] = createNodes(doc, [
      rect(0, 0, { appearance: { strokes } }),
      rect(0, 50, { appearance: { strokes } }),
    ]).nodes;
    if (!a || !b) throw new Error("setup");
    transformNodes(doc, { nodeIds: [a.id], scale: 2 });
    transformNodes(doc, { nodeIds: [b.id], scale: 2, scaleStrokes: false });
    expect(shape(doc, a.id).appearance.strokes[0]).toMatchObject({ width: 2, dash: [4, 2] });
    expect(shape(doc, b.id).appearance.strokes[0]).toMatchObject({ width: 1, dash: [2, 1] });
  });

  it("scales a container's Strokes by √|det| unless scaleStrokes is false (ADR-0043)", () => {
    const { doc, defaultLayerId } = newDoc();
    const appearance = { strokes: [{ color: "#000000", width: 2, dash: [4, 2] }] };
    const [outer, inner, leaf] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        appearance,
        children: [
          {
            type: "group",
            appearance,
            children: [{ type: "rect", x: 0, y: 0, width: 50, height: 30 }],
          },
        ],
      },
    ]).nodes;
    if (!outer || !inner || !leaf) throw new Error("setup");
    const stroke = (id: string) => {
      const n = doc.nodes.get(id);
      return n?.type === "group" ? n.appearance?.strokes[0] : undefined;
    };
    const { nodes } = transformNodes(doc, { nodeIds: [outer.id], scale: { x: 2, y: 8 } });
    expect(nodes.map((n) => n.id)).toEqual([outer.id, inner.id, leaf.id]);
    expect(stroke(outer.id)).toMatchObject({ width: 8, dash: [16, 8] });
    expect(stroke(inner.id)).toMatchObject({ width: 8, dash: [16, 8] });
    transformNodes(doc, { nodeIds: [outer.id], scale: 2, scaleStrokes: false });
    transformNodes(doc, { nodeIds: [leaf.id], scale: 2 });
    expect(stroke(outer.id)).toMatchObject({ width: 8 });
  });

  it("moves a gradient with transform and never rewrites it", () => {
    const { doc, rect } = newDoc();
    const stops = [
      { offset: 0, color: "#000000" },
      { offset: 1, color: "#FFFFFF" },
    ];
    const strokes = [{ type: "gradient" as const, gradient: { type: "linear" as const, stops } }];
    const [r] = createNodes(doc, [rect(0, 0, { appearance: { strokes } })]).nodes;
    if (!r) throw new Error("setup");
    const before = shape(doc, r.id).appearance.strokes[0];
    transformNodes(doc, { nodeIds: [r.id], rotate: 90, scale: 2, scaleStrokes: false });
    const after = shape(doc, r.id).appearance.strokes[0];
    expect(after).toMatchObject({ width: 0.5 });
    expect(after?.type === "gradient" && after.gradient).toEqual(
      before?.type === "gradient" && before.gradient,
    );
  });

  it("scales each axis on its own and skews", () => {
    const { doc, rect } = newDoc();
    const [a] = createNodes(doc, [rect(0, 0)]).nodes;
    if (!a) throw new Error("setup");
    transformNodes(doc, { nodeIds: [a.id], scale: { x: 2, y: 1 }, pivot: "topLeft" });
    expect(shape(doc, a.id).transform).toEqual([2, 0, 0, 1, 0, 0]);
    transformNodes(doc, { nodeIds: [a.id], skew: { x: 45 }, pivot: "topLeft" });
    expect(shape(doc, a.id).transform).toEqual([2, 0, 1, 1, 0, 0]);
  });

  it("moves a listed descendant of another target once and warns", () => {
    const { doc, defaultLayerId } = newDoc();
    const [g, r] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        children: [{ type: "rect", x: 0, y: 0, width: 10, height: 10 }],
      },
    ]).nodes;
    if (!g || !r) throw new Error("setup");
    const { nodes, warnings } = transformNodes(doc, {
      nodeIds: [g.id, r.id],
      translate: { x: 5 },
    });
    expect(nodes.map((n) => n.id)).toEqual([r.id]);
    expect(shape(doc, r.id).transform).toEqual([1, 0, 0, 1, 5, 0]);
    expect(warnings).toEqual([
      { code: "NESTED_TARGET", nodeId: r.id, message: expect.any(String) },
    ]);
  });

  it.each([
    [{ matrix: [0, 0, 0, 0, 5, 5] }],
    [{ skew: { x: 45, y: 45 } }],
    [{ scale: { x: 1, y: 0 } }],
    [{}],
    [{ matrix: [1, 0, 0, 1, 0, 0], rotate: 10 }],
  ])("rejects %j before touching anything", (parts) => {
    const { doc, rect } = newDoc();
    const [a] = createNodes(doc, [rect(0, 0)]).nodes;
    if (!a) throw new Error("setup");
    expect(() => transformNodes(doc, { nodeIds: [a.id], ...parts } as never)).toThrow();
    expect(shape(doc, a.id).transform).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("leaves an empty Group alone", () => {
    const { doc, defaultLayerId } = newDoc();
    const [g] = createNodes(doc, [{ type: "group", parentId: defaultLayerId }]).nodes;
    if (!g) throw new Error("setup");
    expect(transformNodes(doc, { nodeIds: [g.id], rotate: 10 }).nodes).toEqual([]);
  });

  it("returns NODE_NOT_FOUND for an unknown id and changes nothing", () => {
    const { doc, rect } = newDoc();
    const [a] = createNodes(doc, [rect(0, 0)]).nodes;
    if (!a) throw new Error("setup");
    expect(
      errorOf(() => transformNodes(doc, { nodeIds: [a.id, "nope"], translate: { x: 1 } })),
    ).toMatchObject({ code: "NODE_NOT_FOUND", path: "nodeIds[1]", hint: expect.any(String) });
    expect(shape(doc, a.id).transform).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe("transformNodes with transforms (ADR-0070)", () => {
  it("gives each entry's Nodes its own transform about its own centre, as calls in sequence do", () => {
    const { doc, rect } = newDoc();
    const [a, b] = createNodes(doc, [rect(0, 0), rect(100, 0)]).nodes;
    if (!a || !b) throw new Error("setup");
    const one = structuredClone(doc);
    transformNodes(one, { nodeIds: [a.id], rotate: -7 });
    transformNodes(one, { nodeIds: [b.id], rotate: 6 });
    const { nodes } = transformNodes(doc, {
      transforms: [
        { nodeIds: [a.id], rotate: -7 },
        { nodeIds: [b.id], rotate: 6 },
      ],
    });
    expect(nodes.map((n) => n.id)).toEqual([a.id, b.id]);
    expect(doc.nodes).toEqual(one.nodes);
    expect(near(bounds(doc, shape(doc, a.id)))).toEqual(near(bounds(one, shape(one, a.id))));
    expect(shape(doc, a.id).transform).not.toEqual(shape(doc, b.id).transform);
  });

  it("composes two entries on one Node in order, pivoting on the bounds the first left", () => {
    const { doc, rect } = newDoc();
    const [a] = createNodes(doc, [rect(10, 10)]).nodes;
    if (!a) throw new Error("setup");
    const { nodes } = transformNodes(doc, {
      transforms: [
        { nodeIds: [a.id], translate: { x: 10 } },
        { nodeIds: [a.id], rotate: 90 },
      ],
    });
    // Turned about (45, 25), the centre after the move, not (35, 25).
    expect(near(bounds(doc, shape(doc, a.id)))).toEqual({ x: 30, y: 0, width: 30, height: 50 });
    expect(nodes).toEqual([shape(doc, a.id)]);
  });

  it("refuses the whole call for a failing entry, naming it, and changes nothing", () => {
    const { doc, rect } = newDoc();
    const [a] = createNodes(doc, [rect(0, 0)]).nodes;
    if (!a) throw new Error("setup");
    const transforms = [
      { nodeIds: [a.id], rotate: 5 },
      { nodeIds: ["nope"], rotate: 5 },
    ];
    expect(errorOf(() => transformNodes(doc, { transforms }))).toMatchObject({
      code: "NODE_NOT_FOUND",
      path: "transforms[1].nodeIds[0]",
    });
    expect(shape(doc, a.id).transform).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("with partial skips a failing entry whole and applies the others", () => {
    const { doc, rect } = newDoc();
    const [a, b] = createNodes(doc, [rect(0, 0), rect(100, 0)]).nodes;
    if (!a || !b) throw new Error("setup");
    const { nodes, failed } = transformNodes(
      doc,
      {
        transforms: [
          { nodeIds: [a.id], translate: { x: 1 } },
          { nodeIds: [b.id, "nope"], translate: { x: 1 } },
        ],
      },
      { partial: true },
    );
    expect(nodes.map((n) => n.id)).toEqual([a.id]);
    expect(shape(doc, b.id).transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(failed).toEqual([
      expect.objectContaining({
        index: 1,
        code: "NODE_NOT_FOUND",
        path: "transforms[1].nodeIds[1]",
      }),
    ]);
    const transforms = [{ nodeIds: ["x"], rotate: 1 }];
    expect(errorOf(() => transformNodes(doc, { transforms }, { partial: true }))).toMatchObject({
      code: "NODE_NOT_FOUND",
      path: "transforms[0].nodeIds[0]",
    });
  });

  it("warns NESTED_TARGET per entry", () => {
    const { doc, defaultLayerId } = newDoc();
    const [g, r] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        children: [{ type: "rect", x: 0, y: 0, width: 10, height: 10 }],
      },
    ]).nodes;
    if (!g || !r) throw new Error("setup");
    const { warnings } = transformNodes(doc, {
      transforms: [
        { nodeIds: [r.id], translate: { x: 1 } },
        { nodeIds: [g.id, r.id], translate: { x: 1 } },
      ],
    });
    expect(warnings).toEqual([
      { code: "NESTED_TARGET", nodeId: r.id, message: expect.any(String) },
    ]);
    expect(shape(doc, r.id).transform).toEqual([1, 0, 0, 1, 2, 0]);
  });

  it.each([
    [{ transforms: [] }],
    [{ transforms: [{ nodeIds: ["a"], rotate: 1 }], rotate: 5 }],
    [{ transforms: [{ nodeIds: ["a"], matrix: [1, 0, 0, 1, 0, 0], rotate: 1 }] }],
  ])("rejects %j", (input) => {
    const { doc } = newDoc();
    expect(() => transformNodes(doc, input as never)).toThrow();
  });
});

describe("updateNodes", () => {
  const setup = () => {
    const { doc, defaultLayerId, rect } = newDoc();
    const [r, p] = createNodes(doc, [
      rect(10, 10, {
        appearance: {
          fills: [{ color: "#00FF00" }],
          strokes: [{ color: "#000000" }, { color: "#FFFFFF", width: 3 }],
        },
      }),
      { type: "path", parentId: defaultLayerId, d: "M 0 0 L 5 5" },
    ]).nodes;
    if (!r || !p) throw new Error("setup");
    return { doc, defaultLayerId, r, p };
  };

  it("merges common properties, recursing into meta and deleting with null (RFC 7396)", () => {
    const { doc, r } = setup();
    updateNodes(doc, [
      {
        nodeId: r.id,
        patch: {
          name: "Hero",
          visible: false,
          opacity: 0.5,
          blendMode: "multiply",
          tags: ["a"],
          meta: { a: 1, b: 2 },
        },
      },
    ]);
    const { nodes } = updateNodes(doc, [{ nodeId: r.id, patch: { meta: { b: null, c: 3 } } }]);
    expect(nodes.map((n) => n.id)).toEqual([r.id]);
    expect(doc.nodes.get(r.id)).toMatchObject({
      name: "Hero",
      visible: false,
      opacity: 0.5,
      blendMode: "multiply",
      tags: ["a"],
      meta: { a: 1, c: 3 },
    });
  });

  it("changes Live Shape parameters, which changes the derived outline", () => {
    const { doc, r } = setup();
    updateNodes(doc, [{ nodeId: r.id, patch: { radius: 8, width: 60 } }]);
    expect(shape(doc, r.id)).toMatchObject({ radius: 8, width: 60, height: 30 });
    expect(bounds(doc, shape(doc, r.id))).toEqual({ x: 10, y: 10, width: 60, height: 30 });
  });

  it("replaces a whole fills or strokes list and keeps the other", () => {
    const { doc, r } = setup();
    updateNodes(doc, [{ nodeId: r.id, patch: { appearance: { fills: [{ color: "#FF0000" }] } } }]);
    expect(shape(doc, r.id).appearance.fills).toEqual([{ type: "solid", color: "#FF0000" }]);
    expect(shape(doc, r.id).appearance.strokes).toHaveLength(2);
    updateNodes(doc, [
      { nodeId: r.id, patch: { appearance: { strokes: [{ color: "#000000" }] } } },
    ]);
    expect(shape(doc, r.id).appearance.strokes).toEqual([
      {
        type: "solid",
        color: "#000000",
        width: 1,
        cap: "butt",
        join: "miter",
        miterLimit: 10,
        dash: [],
      },
    ]);
  });

  it("fills a gradient's geometry from the bounds as they are after the patch", () => {
    const { doc, r } = setup();
    const stops = [
      { offset: 0, color: "#000000" },
      { offset: 1, color: "#FFFFFF" },
    ];
    const fills = [{ type: "gradient", gradient: { type: "linear", stops } }];
    updateNodes(doc, [{ nodeId: r.id, patch: { width: 200, appearance: { fills } } }]);
    const { x, y, height } = shape(doc, r.id) as ShapeNode & {
      x: number;
      y: number;
      height: number;
    };
    expect(shape(doc, r.id).appearance.fills[0]).toMatchObject({
      gradient: { start: { x, y: y + height / 2 }, end: { x: x + 200, y: y + height / 2 } },
    });
  });

  it("fills a turned Node's gradient geometry from its own, untransformed bounds", () => {
    const { doc, r } = setup();
    transformNodes(doc, { nodeIds: [r.id], rotate: 90 });
    const stops = [
      { offset: 0, color: "#000000" },
      { offset: 1, color: "#FFFFFF" },
    ];
    const fills = [{ type: "gradient", gradient: { type: "linear", stops } }];
    updateNodes(doc, [{ nodeId: r.id, patch: { appearance: { fills } } }]);
    const n = shape(doc, r.id) as ShapeNode & {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    expect(n.appearance.fills[0]).toMatchObject({
      gradient: {
        start: { x: n.x, y: n.y + n.height / 2 },
        end: { x: n.x + n.width, y: n.y + n.height / 2 },
      },
    });
  });

  it("writes template on a Layer, null deleting it, and refuses it on any other type (ADR-0099)", () => {
    const { doc, defaultLayerId, rect } = newDoc();
    const [group, path, image] = createNodes(doc, [
      { type: "group", parentId: defaultLayerId, children: [] },
      { type: "path", parentId: defaultLayerId, d: "M 0 0 L 10 0" },
      {
        type: "image",
        parentId: defaultLayerId,
        file: "a.gif",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
      rect(0, 0),
    ]).nodes as [Node, Node, Node];
    updateNodes(doc, [{ nodeId: defaultLayerId, patch: { template: true } }]);
    expect(doc.nodes.get(defaultLayerId)).toMatchObject({ template: true });
    updateNodes(doc, [{ nodeId: defaultLayerId, patch: { template: null } }]);
    expect(doc.nodes.get(defaultLayerId)).not.toHaveProperty("template");
    // Missing means false, so false is stored as missing too.
    updateNodes(doc, [{ nodeId: defaultLayerId, patch: { template: true } }]);
    updateNodes(doc, [{ nodeId: defaultLayerId, patch: { template: false } }]);
    expect(doc.nodes.get(defaultLayerId)).not.toHaveProperty("template");
    for (const n of [group, path, image]) {
      expect(
        errorOf(() => updateNodes(doc, [{ nodeId: n.id, patch: { template: true } }])),
      ).toMatchObject({
        code: "INVALID_PATCH",
        message: `A ${n.type} has no template.`,
        hint: expect.stringMatching(new RegExp(`^A ${n.type} can write: `)),
        path: "updates[0].patch.template",
      });
    }
  });

  it("changes a star's Inkscape parameters, and refuses twist on a polygon", () => {
    const { doc, defaultLayerId } = newDoc();
    const at = { parentId: defaultLayerId, cx: 0, cy: 0 };
    const [star, polygon] = createNodes(doc, [
      { type: "star", ...at, outerRadius: 10, innerRadius: 4, points: 5 },
      { type: "polygon", ...at, radius: 10, sides: 6 },
    ]).nodes;
    if (!star || !polygon) throw new Error("setup");
    updateNodes(doc, [{ nodeId: star.id, patch: { rounded: 0.5, twist: 5, angle: 45 } }]);
    expect(shape(doc, star.id)).toMatchObject({ rounded: 0.5, twist: 5, angle: 45 });
    expect(
      errorOf(() => updateNodes(doc, [{ nodeId: polygon.id, patch: { twist: 5 } }])),
    ).toMatchObject({ code: "INVALID_PATCH", path: "updates[0].patch.twist" });
  });

  it("changes a spiral's parameters, its d following, and refuses a key it lacks (ADR-0060)", () => {
    const { doc, defaultLayerId } = newDoc();
    const at = { parentId: defaultLayerId, cx: 60, cy: 50, radius: 40 };
    const [spiral] = createNodes(doc, [
      { type: "spiral", ...at, revolution: 2.5, argument: 30, t0: 0.1 },
    ]).nodes;
    if (!spiral) throw new Error("setup");
    const before = formatPath(shapeSegments(shape(doc, spiral.id)));
    updateNodes(doc, [{ nodeId: spiral.id, patch: { revolution: 4, expansion: 0.5 } }]);
    const after = shape(doc, spiral.id);
    expect(after).toMatchObject({ revolution: 4, expansion: 0.5, argument: 30, t0: 0.1 });
    expect(formatPath(shapeSegments(after))).not.toBe(before);
    expect(
      errorOf(() => updateNodes(doc, [{ nodeId: spiral.id, patch: { turns: 4 } }])),
    ).toMatchObject({ code: "INVALID_PATCH", path: "updates[0].patch.turns" });
  });

  it("changes an ellipse's angles and arc type, and refuses an arc type on a rect", () => {
    const { doc, defaultLayerId } = newDoc();
    const at = { parentId: defaultLayerId, x: 0, y: 0, width: 20, height: 10 };
    const [ellipse, rect] = createNodes(doc, [
      { type: "ellipse", ...at },
      { type: "rect", ...at },
    ]).nodes;
    if (!ellipse || !rect) throw new Error("setup");
    updateNodes(doc, [{ nodeId: ellipse.id, patch: { endAngle: 180, arcType: "open" } }]);
    expect(shape(doc, ellipse.id)).toMatchObject({ startAngle: 0, endAngle: 180, arcType: "open" });
    expect(
      errorOf(() => updateNodes(doc, [{ nodeId: rect.id, patch: { arcType: "open" } }])),
    ).toMatchObject({ code: "INVALID_PATCH", path: "updates[0].patch.arcType" });
  });

  it("normalises a Path's new d", () => {
    const { doc, p } = setup();
    updateNodes(doc, [{ nodeId: p.id, patch: { d: "M 0 0 L 10.0004 0" } }]);
    expect(shape(doc, p.id)).toMatchObject({ d: "M 0 0 L 10 0" });
  });

  it("switches a Path's fillRule, and null restores nonzero", () => {
    const { doc, p } = setup();
    expect(shape(doc, p.id)).toMatchObject({ fillRule: "nonzero" });
    updateNodes(doc, [{ nodeId: p.id, patch: { fillRule: "evenodd" } }]);
    expect(shape(doc, p.id)).toMatchObject({ fillRule: "evenodd" });
    updateNodes(doc, [{ nodeId: p.id, patch: { fillRule: null } }]);
    expect(shape(doc, p.id)).toMatchObject({ fillRule: "nonzero" });
    expect(
      errorOf(() => updateNodes(doc, [{ nodeId: p.id, patch: { fillRule: "winding" } }])),
    ).toMatchObject({ code: "INVALID_PATCH", path: "updates[0].patch.fillRule" });
  });

  it.each([
    [{ transform: [1, 0, 0, 1, 0, 0] }, "transform", /node_transform/],
    [{ parentId: "x" }, "parentId", /^Use node_reparent/],
    [{ index: "a0" }, "index", /^Use node_reorder.*node_reparent with the same parentId/],
    [{ type: "ellipse" }, "type", /type/],
    [{ sides: 5 }, "sides", /x, y, width, height, radius/],
    [{ d: "M 0 0" }, "d", /parameters/],
    [{ fillRule: "evenodd" }, "fillRule", /x, y, width/],
    [{ name: null }, "name", /null/],
    [{ width: -1 }, "width", /./],
    [{ constructor: 1 }, "constructor", /x, y, width/],
  ])("rejects %j with INVALID_PATCH", (patch, key, hint) => {
    const { doc, r } = setup();
    expect(errorOf(() => updateNodes(doc, [{ nodeId: r.id, patch }]))).toMatchObject({
      code: "INVALID_PATCH",
      path: `updates[0].patch.${key}`,
      hint: expect.stringMatching(hint),
    });
  });

  it("sets, merges and clears a container's appearance (ADR-0043)", () => {
    const { doc, defaultLayerId, r } = setup();
    const layer = () => doc.nodes.get(defaultLayerId);
    const update = (patch: Record<string, unknown>) =>
      updateNodes(doc, [{ nodeId: defaultLayerId, patch }]);
    update({ appearance: { strokes: [{ color: "#FF0000", width: 2 }] } });
    expect(layer()).toMatchObject({
      appearance: { fills: [], strokes: [{ type: "solid", width: 2 }], contents: 0 },
    });
    update({ appearance: { fills: [{ color: "#00FF00" }], contents: 2 } });
    expect(layer()).toMatchObject({
      appearance: { fills: [{ color: "#00FF00" }], strokes: [{ width: 2 }], contents: 2 },
    });
    expect(errorOf(() => update({ appearance: { strokes: [] } }))).toMatchObject({
      code: "INVALID_INPUT",
      path: "updates[0].patch.appearance.contents",
    });
    update({ appearance: null });
    expect(layer()).not.toHaveProperty("appearance");
    expect(
      errorOf(() => updateNodes(doc, [{ nodeId: r.id, patch: { appearance: { contents: 0 } } }])),
    ).toMatchObject({
      code: "INVALID_PATCH",
      path: "updates[0].patch.appearance.contents",
      hint: expect.stringContaining("Layer's or Group's"),
    });
  });

  it("reports INVALID_COLOR and INVALID_PATH at the patch path", () => {
    const { doc, r, p } = setup();
    expect(
      errorOf(() =>
        updateNodes(doc, [{ nodeId: r.id, patch: { appearance: { fills: [{ color: "red" }] } } }]),
      ),
    ).toMatchObject({
      code: "INVALID_COLOR",
      path: "updates[0].patch.appearance.fills[0].color",
      hint: expect.stringContaining("#FF0000"),
    });
    expect(
      errorOf(() => updateNodes(doc, [{ nodeId: p.id, patch: { d: "M 0 0 h 1" } }])),
    ).toMatchObject({ code: "INVALID_PATH", path: "updates[0].patch.d" });
  });

  it("applies two patches to one Node in order", () => {
    const { doc, r } = setup();
    const { nodes } = updateNodes(doc, [
      { nodeId: r.id, patch: { name: "a", x: 0 } },
      { nodeId: r.id, patch: { opacity: 0.5, x: 100 } },
    ]);
    expect(doc.nodes.get(r.id)).toMatchObject({ name: "a", opacity: 0.5, x: 100 });
    expect(nodes).toHaveLength(1);
    expect(bounds(doc, nodes[0] as Node)).toEqual({ x: 100, y: 10, width: 50, height: 30 });
  });

  it("changes nothing when one item fails", () => {
    const { doc, r } = setup();
    expect(
      errorOf(() =>
        updateNodes(doc, [
          { nodeId: r.id, patch: { name: "changed" } },
          { nodeId: "nope", patch: { name: "x" } },
        ]),
      ),
    ).toMatchObject({ code: "NODE_NOT_FOUND", path: "updates[1].nodeId" });
    expect(doc.nodes.get(r.id)?.name).toBe("");
  });
});

describe("deleteNodes", () => {
  it("deletes a Group with its descendants, each id once", () => {
    const { doc, defaultLayerId, rect } = newDoc();
    const [g, a, inner, b] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        children: [
          { type: "rect", x: 0, y: 0, width: 10, height: 10 },
          { type: "group", children: [{ type: "line", x1: 0, y1: 0, x2: 50, y2: 5 }] },
        ],
      },
      rect(100, 0),
    ]).nodes;
    if (!g || !a || !inner || !b) throw new Error("setup");
    const { deletedIds } = deleteNodes(doc, [g.id, b.id]);
    expect(deletedIds).toEqual([g.id, a.id, inner.id, b.id]);
    expect(outline(doc)).toMatchObject([{ id: defaultLayerId, childCount: 1 }]);
    expect([...doc.nodes.keys()]).not.toContain(b.id);
  });

  /** The Nodes of `doc` after a `.kalamo.json` round trip; throws if the file does not open. */
  const reopened = (doc: Document) =>
    new Map(parseDocument(serializeDocument(doc)).nodes.map((n) => [n.id, n]));

  it("refuses deleting the only top-level Layer with LAST_LAYER and changes nothing", () => {
    const { doc, defaultLayerId } = newDoc();
    expect(errorOf(() => deleteNodes(doc, [defaultLayerId]))).toEqual({
      code: "LAST_LAYER",
      message: "A Document keeps at least one top-level Layer.",
      hint: expect.stringContaining("create another top-level Layer first"),
      path: "nodeIds[0]",
      nodeIds: [defaultLayerId],
    });
    expect(outline(doc)).toMatchObject([{ id: defaultLayerId }]);
    expect(reopened(doc)).toEqual(doc.nodes);
  });

  it("deletes top-level Layers while one is left; all of them only with partial, less the last", () => {
    const { doc, defaultLayerId } = newDoc();
    const [l2, l3] = createNodes(doc, [{ type: "layer" }, { type: "layer" }]).nodes;
    if (!l2 || !l3) throw new Error("setup");
    const all = [defaultLayerId, l2.id, l3.id];
    const refused = structuredClone(doc);
    expect(errorOf(() => deleteNodes(refused, all))).toMatchObject({
      code: "LAST_LAYER",
      path: "nodeIds[2]",
      nodeIds: all,
    });
    expect(reopened(refused)).toEqual(doc.nodes);
    expect(deleteNodes(structuredClone(doc), all.slice(0, 2)).deletedIds).toEqual(all.slice(0, 2));
    const { deletedIds, failed } = deleteNodes(doc, all, { partial: true });
    expect(deletedIds).toEqual(all.slice(0, 2));
    expect(failed).toMatchObject([{ index: 2, code: "LAST_LAYER", nodeIds: [l3.id] }]);
    expect(outline(doc)).toMatchObject([{ id: l3.id }]);
  });

  it("deletes a sub-Layer and the contents of the last Layer, down to one blank Layer", () => {
    const { doc, defaultLayerId, rect } = newDoc();
    const [sub, a] = createNodes(doc, [
      { type: "layer", parentId: defaultLayerId },
      rect(0, 0),
    ]).nodes;
    if (!sub || !a) throw new Error("setup");
    expect(deleteNodes(doc, [sub.id, a.id]).deletedIds).toEqual([sub.id, a.id]);
    expect(outline(doc)).toEqual([expect.objectContaining({ id: defaultLayerId, childCount: 0 })]);
  });

  it("counts Layers after the whole delete, whichever order the Layer and its children come in", () => {
    for (const first of [true, false]) {
      const { doc, defaultLayerId, rect } = newDoc();
      const [a] = createNodes(doc, [rect(0, 0)]).nodes;
      if (!a) throw new Error("setup");
      const ids = first ? [defaultLayerId, a.id] : [a.id, defaultLayerId];
      expect(errorOf(() => deleteNodes(doc, ids))).toMatchObject({ code: "LAST_LAYER" });
      expect(doc.nodes.has(a.id)).toBe(true);
      const { deletedIds, failed } = deleteNodes(doc, ids, { partial: true });
      expect(deletedIds).toEqual([a.id]);
      expect(failed).toMatchObject([{ index: ids.indexOf(defaultLayerId), code: "LAST_LAYER" }]);
    }
  });

  it("leaves a Document with no top-level Layer writable: a top-level Layer can be created", () => {
    const { doc, defaultLayerId } = newDoc();
    doc.nodes.delete(defaultLayerId);
    createNodes(doc, [{ type: "layer" }]);
    expect(outline(doc)).toHaveLength(1);
  });

  it("returns NODE_NOT_FOUND for an unknown id and deletes nothing", () => {
    const { doc, rect } = newDoc();
    const [a] = createNodes(doc, [rect(0, 0)]).nodes;
    if (!a) throw new Error("setup");
    expect(errorOf(() => deleteNodes(doc, [a.id, "nope"]))).toMatchObject({
      code: "NODE_NOT_FOUND",
      path: "nodeIds[1]",
    });
    expect(doc.nodes.has(a.id)).toBe(true);
  });
});

describe("partial", () => {
  it("applies the valid items and reports the rest by index", () => {
    const { doc, rect } = newDoc();
    const [a] = createNodes(doc, [rect(0, 0)]).nodes;
    if (!a) throw new Error("setup");
    const { nodes, failed } = updateNodes(
      doc,
      [
        { nodeId: a.id, patch: { name: "ok" } },
        { nodeId: "nope", patch: { name: "x" } },
        { nodeId: a.id, patch: { appearance: { fills: [{ color: "red" }] } } },
      ],
      { partial: true },
    );
    expect(nodes.map((n) => n.id)).toEqual([a.id]);
    expect(doc.nodes.get(a.id)?.name).toBe("ok");
    expect(failed).toEqual([
      expect.objectContaining({ index: 1, code: "NODE_NOT_FOUND", path: "updates[1].nodeId" }),
      expect.objectContaining({
        index: 2,
        code: "INVALID_COLOR",
        path: "updates[2].patch.appearance.fills[0].color",
        hint: expect.any(String),
      }),
    ]);
  });

  it("does the same for delete and transform, and throws when nothing applies", () => {
    const { doc, rect } = newDoc();
    const [a, b] = createNodes(doc, [rect(0, 0), rect(0, 50)]).nodes;
    if (!a || !b) throw new Error("setup");
    const moved = transformNodes(
      doc,
      { nodeIds: ["nope", a.id], translate: { x: 1 } },
      { partial: true },
    );
    expect(moved.nodes.map((n) => n.id)).toEqual([a.id]);
    expect(moved.failed).toMatchObject([{ index: 0, code: "NODE_NOT_FOUND" }]);
    const gone = deleteNodes(doc, [b.id, "nope"], { partial: true });
    expect(gone.deletedIds).toEqual([b.id]);
    expect(gone.failed).toMatchObject([{ index: 1, path: "nodeIds[1]" }]);
    expect(errorOf(() => deleteNodes(doc, ["x", "y"], { partial: true }))).toMatchObject({
      code: "NODE_NOT_FOUND",
      path: "nodeIds[0]",
    });
  });
});

describe("updateNodes on a text", () => {
  const setup = () => {
    const { doc, defaultLayerId } = newDoc();
    const [t] = createNodes(doc, [
      { type: "text", parentId: defaultLayerId, x: 10, y: 50, content: "Hi" },
    ]).nodes;
    if (!t) throw new Error("setup");
    return { doc, t };
  };
  const width = (doc: ReturnType<typeof setup>["doc"], id: string) => {
    const n = doc.nodes.get(id);
    return (n && bounds(doc, n)?.width) ?? 0;
  };

  it("rewrites content and fontSize, which changes the bounds", () => {
    const { doc, t } = setup();
    updateNodes(doc, [{ nodeId: t.id, patch: { content: "Hi Hi" } }]);
    expect(width(doc, t.id)).toBeCloseTo(23.952);
    updateNodes(doc, [{ nodeId: t.id, patch: { fontSize: 24 } }]);
    expect(width(doc, t.id)).toBeCloseTo(47.904);
  });

  it("writes fontStyle, measured in its face", () => {
    const { doc, t } = setup();
    updateNodes(doc, [{ nodeId: t.id, patch: { fontStyle: "Bold Italic" } }]);
    expect(doc.nodes.get(t.id)).toMatchObject({ fontStyle: "Bold Italic" });
    expect(width(doc, t.id)).toBeCloseTo(((652 + 265) * 12) / 1000);
  });

  it("keeps any font name", () => {
    const { doc, t } = setup();
    updateNodes(doc, [{ nodeId: t.id, patch: { fontFamily: "Arial" } }]);
    expect(doc.nodes.get(t.id)).toMatchObject({ fontFamily: "Arial" });
  });

  it("writes hard returns, and leading, which null returns to Auto", () => {
    const { doc, t } = setup();
    updateNodes(doc, [{ nodeId: t.id, patch: { content: "a\nb", leading: 15 } }]);
    expect(doc.nodes.get(t.id)).toMatchObject({ content: "a\nb", leading: 15 });
    updateNodes(doc, [{ nodeId: t.id, patch: { leading: null } }]);
    expect(doc.nodes.get(t.id)).not.toHaveProperty("leading");
  });

  it("writes an Area Type's frame, and refuses to delete it", () => {
    const { doc, defaultLayerId } = newDoc();
    const [a] = createNodes(doc, [
      {
        type: "text",
        kind: "area",
        parentId: defaultLayerId,
        x: 0,
        y: 0,
        width: 50,
        height: 20,
        content: "Hi",
      },
    ]).nodes;
    if (!a) throw new Error("setup");
    updateNodes(doc, [{ nodeId: a.id, patch: { width: 200 } }]);
    expect(doc.nodes.get(a.id)).toMatchObject({ width: 200, height: 20 });
    expect(
      errorOf(() => updateNodes(doc, [{ nodeId: a.id, patch: { height: null } }])),
    ).toMatchObject({
      code: "INVALID_PATCH",
      path: "updates[0].patch.height",
      hint: expect.stringMatching(/required/),
    });
  });

  it.each([
    [{ kind: "area", content: "x" }, "content", /Convert first/],
    [{ kind: "text" }, "kind", /./],
    [{ width: 10 }, "width", /leading/],
    [{ content: "a\tb" }, "content", /./],
    [{ d: "M 0 0" }, "d", /outline/i],
    [{ alignment: "middle" }, "alignment", /left.*center.*right.*justify/],
  ])("rejects %j with INVALID_PATCH", (patch, key, hint) => {
    const { doc, t } = setup();
    const error = errorOf(() => updateNodes(doc, [{ nodeId: t.id, patch }]));
    expect(error).toMatchObject({
      code: "INVALID_PATCH",
      path: `updates[0].patch.${key}`,
      hint: expect.stringMatching(hint),
    });
    if (key === "width")
      expect(error.hint).toMatch(
        /meta, x, y, content, fontFamily, fontStyle, fontSize, leading, tracking, alignment, ranges, appearance/,
      );
  });

  it("stores no alignment for left on update (ADR-0077)", () => {
    const { doc, t } = setup();
    const [centred] = updateNodes(doc, [{ nodeId: t.id, patch: { alignment: "center" } }])
      .nodes as [Node];
    expect(centred).toMatchObject({ alignment: "center" });
    const [back] = updateNodes(doc, [{ nodeId: t.id, patch: { alignment: "left" } }]).nodes as [
      Node,
    ];
    expect(back).not.toHaveProperty("alignment");
  });

  describe("tracking and Character Ranges (ADR-0029)", () => {
    const withRanges = () => {
      const { doc, defaultLayerId } = newDoc();
      const [t] = createNodes(doc, [
        {
          type: "text",
          parentId: defaultLayerId,
          x: 10,
          y: 50,
          content: "Hello",
          ranges: [{ start: 0, end: 1, fill: "#FF0000" }],
        },
      ]).nodes;
      if (!t) throw new Error("setup");
      const update = (patch: Record<string, unknown>) => {
        updateNodes(doc, [{ nodeId: t.id, patch }]);
        return doc.nodes.get(t.id);
      };
      return { doc, t, update };
    };

    it("clears the ranges when content is written without them", () => {
      expect(withRanges().update({ content: "Bye" })).not.toHaveProperty("ranges");
    });

    it("stores ranges written with content, and removes them on null", () => {
      const { update } = withRanges();
      const ranges = [{ start: 0, end: 1, fill: "#00FF00" }];
      expect(update({ content: "Bye", ranges })).toHaveProperty("ranges", ranges);
      expect(update({ ranges: null })).not.toHaveProperty("ranges");
    });

    it("refuses a range past the content's end", () => {
      const { doc, t } = withRanges();
      expect(
        errorOf(() =>
          updateNodes(doc, [{ nodeId: t.id, patch: { ranges: [{ start: 0, end: 9 }] } }]),
        ),
      ).toMatchObject({ code: "INVALID_PATCH", path: "updates[0].patch.ranges[0].end" });
    });

    it("writes tracking, which null removes", () => {
      const { update } = withRanges();
      expect(update({ tracking: 50 })).toMatchObject({ tracking: 50 });
      expect(update({ tracking: null })).not.toHaveProperty("tracking");
    });
  });
});

describe("a Clipping Path under node_update and node_create (ADR-0021)", () => {
  const setup = () => {
    const { doc, defaultLayerId, rect } = newDoc();
    const [group, content, clip] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        children: [rect(0, 0), rect(5, 5)].map(({ parentId: _, ...child }) => child),
      },
    ]).nodes;
    if (!group || !content || !clip) throw new Error("setup");
    doc.nodes.set(clip.id, { ...shape(doc, clip.id), clipping: true });
    return { doc, content, clip, rect };
  };

  it("keeps clipping read-only, pointing at mask_make and mask_release", () => {
    const { doc, content } = setup();
    const e = errorOf(() => updateNodes(doc, [{ nodeId: content.id, patch: { clipping: true } }]));
    expect(e).toMatchObject({ code: "INVALID_PATCH", path: "updates[0].patch.clipping" });
    expect(e.hint).toMatch(/mask_make/);
    expect(e.hint).toMatch(/mask_release/);
  });

  it("refuses to hide a Clipping Path, and hides its content", () => {
    const { doc, content, clip } = setup();
    const e = errorOf(() => updateNodes(doc, [{ nodeId: clip.id, patch: { visible: false } }]));
    expect(e).toMatchObject({ code: "INVALID_PATCH", path: "updates[0].patch.visible" });
    expect(e.hint).toMatch(/mask_release/);
    updateNodes(doc, [{ nodeId: content.id, patch: { visible: false } }]);
    expect(doc.nodes.get(content.id)?.visible).toBe(false);
  });

  it("refuses to hide a text Clipping Path", () => {
    const { doc, clip } = setup();
    const [text] = createNodes(doc, [
      { type: "text", parentId: clip.parentId as string, x: 0, y: 20, content: "Hi" },
    ]).nodes;
    if (!text) throw new Error("setup");
    doc.nodes.set(clip.id, { ...shape(doc, clip.id), clipping: undefined });
    doc.nodes.set(text.id, { ...text, clipping: true } as Node);
    const e = errorOf(() => updateNodes(doc, [{ nodeId: text.id, patch: { visible: false } }]));
    expect(e).toMatchObject({ code: "INVALID_PATCH", path: "updates[0].patch.visible" });
  });

  it("refuses clipping given to node_create, as any key a node does not take", () => {
    const { doc, rect } = setup();
    expect(() => createNodes(doc, [rect(0, 0, { clipping: true })])).toThrow(/clipping/);
  });
});

describe("an Image", () => {
  const withImage = () => {
    const { doc, defaultLayerId } = newDoc();
    const src = "a".repeat(64);
    doc.images.set(src, { mime: "image/png", width: 24, height: 16 });
    const [node] = createNodes(doc, [{ type: "image", parentId: defaultLayerId, src, x: 0, y: 0 }])
      .nodes as [Node];
    return { doc, id: node.id };
  };
  const update = (patch: Record<string, unknown>) => {
    const { doc, id } = withImage();
    const [node] = updateNodes(doc, [{ nodeId: id, patch }]).nodes;
    return node;
  };

  it("writes its frame and preserveAspectRatio, spelled one way", () => {
    expect(update({ width: 48, preserveAspectRatio: "xMidYMid" })).toMatchObject({
      width: 48,
      preserveAspectRatio: "xMidYMid meet",
    });
    expect(update({ preserveAspectRatio: "defer xMinYMax slice" })).toMatchObject({
      preserveAspectRatio: "xMinYMax slice",
    });
  });

  it.each([
    ["src: null", { src: null }, /Relink/],
    ["an Appearance", { appearance: { fills: [] } }, /x, y, width, height, preserveAspectRatio/],
    ["a bad preserveAspectRatio", { preserveAspectRatio: "stretch" }, /meet or slice/],
    ["a zero width", { width: 0 }, /./],
  ])("refuses %s", (_, patch, hint) => {
    const { doc, id } = withImage();
    expect(errorOf(() => updateNodes(doc, [{ nodeId: id, patch }]))).toMatchObject({
      code: "INVALID_PATCH",
      hint: expect.stringMatching(hint),
    });
  });

  it("takes an oriented file's upright size and box, inline children too (ADR-0101)", () => {
    const { doc, defaultLayerId } = newDoc();
    const src = "a".repeat(64);
    doc.images.set(src, { mime: "image/jpeg", width: 24, height: 16 });
    const orientations = new Map([
      ["nodes[0]", 6],
      ["nodes[1].children[0]", 6],
      ["nodes[2]", 2],
    ] as const);
    const nodes = createNodes(
      doc,
      [
        { type: "image", parentId: defaultLayerId, src, x: 0, y: 0 },
        {
          type: "group",
          parentId: defaultLayerId,
          children: [
            {
              type: "image",
              src,
              x: 10,
              y: 20,
              width: 30,
              height: 50,
              preserveAspectRatio: "xMinYMid meet",
            },
          ],
        },
        { type: "image", parentId: defaultLayerId, src, x: 5, y: 5 },
        // The same id with no orientation: stored pixels are upright.
        { type: "image", parentId: defaultLayerId, src, x: 0, y: 0 },
      ],
      { orientations },
    ).nodes.filter((n) => n.type === "image");
    const [byDefault, boxed, mirrored, plain] = nodes as Node[];
    expect(byDefault).toMatchObject({
      x: -4,
      y: 4,
      width: 24,
      height: 16,
      transform: [0, 1, -1, 0, 20, 4],
    });
    expect(bounds(doc, byDefault as Node)).toEqual({ x: 0, y: 0, width: 16, height: 24 });
    expect(boxed).toMatchObject({
      x: 0,
      y: 30,
      width: 50,
      height: 30,
      preserveAspectRatio: "xMidYMax meet",
    });
    expect(bounds(doc, boxed as Node)).toEqual({ x: 10, y: 20, width: 30, height: 50 });
    expect(mirrored).toMatchObject({
      x: 5,
      y: 5,
      width: 24,
      height: 16,
      transform: [-1, 0, 0, 1, 34, 0],
    });
    expect(plain).toMatchObject({ width: 24, height: 16, transform: [1, 0, 0, 1, 0, 0] });
  });

  it("Relinks to an oriented file in the box the patch leaves, after its transform (ADR-0101)", () => {
    const { doc, id } = withImage();
    transformNodes(doc, { nodeIds: [id], translate: { x: 100, y: 0 } });
    const before = doc.nodes.get(id) as Node;
    const src = "b".repeat(64);
    doc.images.set(src, { mime: "image/jpeg", width: 16, height: 24 });
    const [node] = updateNodes(
      doc,
      [{ nodeId: id, patch: { src, width: 48, preserveAspectRatio: "xMinYMin meet" } }],
      { orientations: new Map([["updates[0]", 6]]) },
    ).nodes as [Node];
    // The box: x 0, y 0, 48 × 16, moved 100 right; its centre (24, 8).
    expect(node).toMatchObject({
      x: 16,
      y: -16,
      width: 16,
      height: 48,
      preserveAspectRatio: "xMinYMax meet",
      transform: [0, 1, -1, 0, 132, -16],
    });
    expect(bounds(doc, node)).toEqual({ ...bounds(doc, before), width: 48 });
    // An id, or an upright file, keeps the frame and transform as before.
    const [same] = updateNodes(doc, [{ nodeId: id, patch: { src: "a".repeat(64) } }]).nodes;
    expect(same).toMatchObject({ x: 16, y: -16, width: 16, height: 48, transform: node.transform });
  });

  it("moves by its transform, keeping its frame, with or without scaling Strokes", () => {
    for (const scaleStrokes of [true, false]) {
      const { doc, id } = withImage();
      const [moved] = transformNodes(doc, { nodeIds: [id], scale: 2, scaleStrokes }).nodes;
      expect(moved).toMatchObject({ x: 0, y: 0, width: 24, height: 16 });
      expect(moved).not.toHaveProperty("appearance");
      expect(bounds(doc, moved as Node)).toEqual({ x: -12, y: -8, width: 48, height: 32 });
    }
  });
});

describe("container gradients (#107)", () => {
  const stops = [
    { offset: 0, color: "#000000" },
    { offset: 1, color: "#FFFFFF" },
  ];
  type G = Extract<Node, { type: "group" }>;
  const gradients = (doc: { nodes: Map<string, Node> }, id: string) => {
    const a = (doc.nodes.get(id) as G).appearance;
    return [...(a?.fills ?? []), ...(a?.strokes ?? [])].map((p) =>
      p.type === "gradient" ? p.gradient : undefined,
    ) as Gradient[];
  };
  /** Where `q` falls along the gradient, 0 at its first stop and 1 at its last. */
  const along = (g: Gradient, [x, y]: [number, number]) => {
    if (g.type === "linear") {
      const [dx, dy] = [g.end.x - g.start.x, g.end.y - g.start.y];
      return ((x - g.start.x) * dx + (y - g.start.y) * dy) / (dx * dx + dy * dy);
    }
    // Into the circle the ellipse is, then the t whose circle about the focus passes through q.
    const back = invert(ellipseMatrix(g) ?? IDENTITY);
    const [qx, qy] = applyTo(back, x, y);
    const [fx, fy] = applyTo(back, g.focus.x, g.focus.y);
    const [wx, wy] = [qx - fx, qy - fy];
    const [ex, ey] = [g.center.x - fx, g.center.y - fy];
    const a = ex * ex + ey * ey - g.radius * g.radius;
    const b = wx * ex + wy * ey;
    const c = wx * wx + wy * wy;
    return Math.abs(a) < 1e-12 ? c / (2 * b) : (b - Math.sqrt(b * b - a * c)) / a;
  };
  const samples: [number, number][] = [
    [0, 0],
    [30, 5],
    [60, 25],
    [12, 38],
    [45, 20],
  ];
  const setup = () => {
    const { doc, defaultLayerId } = newDoc();
    const [outer, inner, a, b] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        appearance: {
          fills: [{ type: "gradient", gradient: { type: "linear", stops, angle: 30 } }],
          strokes: [
            {
              type: "gradient",
              width: 2,
              gradient: {
                type: "radial",
                stops,
                aspectRatio: 0.5,
                angle: 20,
                focus: { x: 35, y: 18 },
              },
            },
          ],
        },
        children: [
          {
            type: "group",
            appearance: { fills: [{ type: "gradient", gradient: { type: "linear", stops } }] },
            children: [{ type: "rect", x: 0, y: 0, width: 50, height: 30 }],
          },
          { type: "rect", x: 20, y: 10, width: 40, height: 30 },
        ],
      },
    ]).nodes;
    if (!outer || !inner || !a || !b) throw new Error("setup");
    return { doc, outer, inner, a, b };
  };

  for (const [name, t] of [
    ["a move", { translate: { x: 7, y: -3 } }],
    ["a turn", { rotate: 35 }],
    ["an uneven scale", { scale: { x: 2, y: 0.5 } }],
    ["a skew", { skew: { x: 25, y: -10 }, scale: { x: 1.5, y: 1 } }],
    ["a mirror", { scale: { x: -1, y: 1 }, rotate: 10 }],
  ] as const) {
    it(`maps every container's gradient through ${name}, so the field is the old one moved`, () => {
      const { doc, outer, inner } = setup();
      const before = [...gradients(doc, outer.id), ...gradients(doc, inner.id)];
      const pivot = { x: 30, y: 20 };
      for (const scaleStrokes of [true, false]) {
        const s = setup();
        const { nodes } = transformNodes(s.doc, {
          nodeIds: [s.outer.id],
          ...t,
          pivot,
          scaleStrokes,
        });
        expect(nodes.slice(0, 2).map((n) => n.id)).toEqual([s.outer.id, s.inner.id]);
        const after = [...gradients(s.doc, s.outer.id), ...gradients(s.doc, s.inner.id)];
        const m = compose(t, pivot);
        after.forEach((g, i) => {
          // Stored at 3 decimals, so a thin ellipse's aspectRatio is off by up to a few parts in 1000.
          for (const q of samples) {
            expect(along(g, applyTo(m, ...q))).toBeCloseTo(along(before[i] as Gradient, q), 2);
          }
        });
      }
    });
  }

  it("keeps a container Stroke's line and scales its width only with scaleStrokes", () => {
    const { doc, outer } = setup();
    transformNodes(doc, { nodeIds: [outer.id], scale: 3 });
    expect((doc.nodes.get(outer.id) as G).appearance?.strokes[0]).toMatchObject({
      type: "gradient",
      width: 6,
      cap: "butt",
    });
    transformNodes(doc, { nodeIds: [outer.id], scale: 2, scaleStrokes: false });
    expect((doc.nodes.get(outer.id) as G).appearance?.strokes[0]).toMatchObject({ width: 6 });
  });

  it("maps each target through its own matrix with each: true", () => {
    const { doc, inner, b } = setup();
    // Two Groups side by side, each turning about its own centre.
    const [other] = createNodes(doc, [
      {
        type: "group",
        parentId: inner.parentId as string,
        appearance: { fills: [{ type: "gradient", gradient: { type: "linear", stops } }] },
        children: [{ type: "rect", x: 100, y: 0, width: 20, height: 20 }],
      },
    ]).nodes;
    if (!other) throw new Error("setup");
    transformNodes(doc, { nodeIds: [inner.id, other.id], rotate: 90, each: true });
    expect(gradients(doc, inner.id)[0]).toMatchObject({
      start: { x: 25, y: -10 },
      end: { x: 25, y: 40 },
    });
    expect(gradients(doc, other.id)[0]).toMatchObject({
      start: { x: 110, y: 0 },
      end: { x: 110, y: 20 },
    });
    expect(doc.nodes.get(b.id)).toMatchObject({ transform: [1, 0, 0, 1, 0, 0] });
  });

  it("leaves the containers' gradients alone when only a leaf moves", () => {
    const { doc, outer, inner, a } = setup();
    const before = [...gradients(doc, outer.id), ...gradients(doc, inner.id)];
    const { nodes } = transformNodes(doc, { nodeIds: [a.id], rotate: 45, scale: 2 });
    expect(nodes.map((n) => n.id)).toEqual([a.id]);
    expect([...gradients(doc, outer.id), ...gradients(doc, inner.id)]).toEqual(before);
  });

  it("switches a Group from solid to gradient in one patch, placed on its bounds", () => {
    const { doc, inner } = setup();
    updateNodes(doc, [
      { nodeId: inner.id, patch: { appearance: { fills: [{ color: "#FF0000" }] } } },
    ]);
    updateNodes(doc, [
      {
        nodeId: inner.id,
        patch: {
          appearance: {
            fills: [{ type: "gradient", gradient: { type: "linear", stops, angle: 90 } }],
          },
        },
      },
    ]);
    expect(gradients(doc, inner.id)).toMatchObject([
      { type: "linear", start: { x: 25, y: 0 }, end: { x: 25, y: 30 } },
    ]);
    expect(
      errorOf(() =>
        updateNodes(doc, [
          {
            nodeId: inner.id,
            patch: {
              appearance: {
                fills: [{ type: "gradient", gradient: { type: "linear", stops: [stops[0]] } }],
              },
            },
          },
        ]),
      ),
    ).toMatchObject({ code: "INVALID_PATCH" });
  });
});

describe("reparentNodes (ADR-0071)", () => {
  /** Layer A holds a path and a rect; Layer B holds Group G, which holds g1 below g2. */
  const scene = () => {
    const { doc, defaultLayerId: a } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const [path, rect] = createNodes(doc, [
      { type: "path", parentId: a, d: "M0 0 L10 20 L30 5 Z", clientKey: "p" },
      { type: "rect", parentId: a, x: 50, y: 0, width: 10, height: 10 },
    ]).nodes as [Node, Node];
    transformNodes(doc, { nodeIds: [path.id], rotate: 30 });
    const [layer] = createNodes(doc, [{ type: "layer", name: "B" }]).nodes as [Node];
    const { nodes, keyMap: made } = createNodes(doc, [
      {
        type: "group",
        parentId: layer.id,
        clientKey: "G",
        children: [
          { type: "rect", x: 0, y: 50, width: 10, height: 10, clientKey: "g1" },
          { type: "ellipse", x: 20, y: 50, width: 10, height: 10, clientKey: "g2" },
        ],
      },
    ]);
    const keyMap: Record<string, string> = { ...made, B: layer.id };
    const id = (k: string) => keyMap[k] as string;
    const kids = (parentId: string | null) => childrenOf(doc, parentId).map((n) => n.id);
    return { doc, a, path: doc.nodes.get(path.id) as Node, rect, nodes, id, kids };
  };
  type Scene = ReturnType<typeof scene>;

  it("moves a path from Layer A into Group G in Layer B, on top by default, geometry unchanged", () => {
    const { doc, path, id, kids } = scene();
    const before = { transform: shape(doc, path.id).transform, bounds: bounds(doc, path) };
    const { nodes, failed } = reparentNodes(doc, [{ nodeId: path.id, parentId: id("G") }]);
    expect(failed).toEqual([]);
    expect(nodes.map((n) => n.id)).toEqual([path.id]);
    expect(kids(id("G"))).toEqual([id("g1"), id("g2"), path.id]);
    const after = doc.nodes.get(path.id) as ShapeNode;
    expect(after.transform).toEqual(before.transform);
    expect(bounds(doc, after)).toEqual(before.bounds);
  });

  it.each([
    [{ index: 0 }, ["P", "g1", "g2"]],
    [{ index: 1 }, ["g1", "P", "g2"]],
    [{ index: 2 }, ["g1", "g2", "P"]],
    [{ before: "g1" }, ["P", "g1", "g2"]],
    [{ before: "g2" }, ["g1", "P", "g2"]],
    [{ after: "g1" }, ["g1", "P", "g2"]],
    [{ after: "g2" }, ["g1", "g2", "P"]],
  ])("lands exactly where %o asks", (position, order) => {
    const { doc, path, id, kids } = scene();
    const ref = (k: string) => (k === "P" ? path.id : id(k));
    const at = Object.fromEntries(
      Object.entries(position).map(([k, v]) => [k, typeof v === "string" ? ref(v) : v]),
    );
    reparentNodes(doc, [{ nodeId: path.id, parentId: id("G"), ...at }]);
    expect(kids(id("G"))).toEqual(order.map(ref));
  });

  it("restacks within the parent: index 0 puts the top Node at the bottom, other keys unchanged", () => {
    const { doc, a, path, rect, kids } = scene();
    const pathKey = (doc.nodes.get(path.id) as Node).index;
    expect(kids(a)).toEqual([path.id, rect.id]);
    const { nodes } = reparentNodes(doc, [{ nodeId: rect.id, parentId: a, index: 0 }]);
    expect(kids(a)).toEqual([rect.id, path.id]);
    expect((doc.nodes.get(path.id) as Node).index).toBe(pathKey);
    expect(nodes.map((n) => n.id)).toEqual([rect.id]);
  });

  it("keeps a key already in the slot, and gives a new one only when it is not", () => {
    const { doc, a, path, rect } = scene();
    const key = rect.index;
    reparentNodes(doc, [{ nodeId: rect.id, parentId: a }]);
    expect((doc.nodes.get(rect.id) as Node).index).toBe(key);
    reparentNodes(doc, [{ nodeId: rect.id, parentId: a, before: path.id }]);
    expect((doc.nodes.get(rect.id) as Node).index < path.index).toBe(true);
  });

  it("applies two moves of one Node in order, listing it once with its final place", () => {
    const { doc, a, path, id, kids } = scene();
    const { nodes } = reparentNodes(doc, [
      { nodeId: path.id, parentId: id("G") },
      { nodeId: id("g1"), parentId: a },
      { nodeId: path.id, parentId: id("B"), index: 0 },
    ]);
    expect(nodes.map((n) => n.id)).toEqual([path.id, id("g1")]);
    expect(nodes[0]).toMatchObject({ parentId: id("B") });
    expect(kids(id("B"))).toEqual([path.id, id("G")]);
    expect(kids(id("G"))).toEqual([id("g2")]);
  });

  it("moves a sub-Layer to the root, and a top-level Layer into another Layer", () => {
    const { doc, a, id, kids } = scene();
    reparentNodes(doc, [{ nodeId: id("B"), parentId: a }]);
    expect(kids(null)).toEqual([a]);
    expect(kids(a).at(-1)).toBe(id("B"));
    reparentNodes(doc, [{ nodeId: id("B"), parentId: null, index: 0 }]);
    expect(kids(null)).toEqual([id("B"), a]);
    expect(doc.nodes.get(id("B"))).toMatchObject({ parentId: null });
  });

  it("does not check locks: a locked Node in a locked Layer moves (ADR-0027)", () => {
    const { doc, a, path, id } = scene();
    updateNodes(doc, [
      { nodeId: a, patch: { locked: true } },
      { nodeId: path.id, patch: { locked: true } },
      { nodeId: id("G"), patch: { locked: true } },
    ]);
    reparentNodes(doc, [{ nodeId: path.id, parentId: id("G") }]);
    expect(doc.nodes.get(path.id)).toMatchObject({ parentId: id("G"), locked: true });
  });

  it.each([
    [
      "a Group into its own child",
      (s: Scene) => ({ nodeId: s.id("G"), parentId: s.id("g1") }),
      "INVALID_PARENT",
      "moves[0].parentId",
    ],
    [
      "a Group into itself",
      (s: Scene) => ({ nodeId: s.id("G"), parentId: s.id("G") }),
      "INVALID_PARENT",
      "moves[0].parentId",
    ],
    [
      "a Layer into its own sub-Layer",
      (s: Scene) => ({ nodeId: s.a, parentId: s.a }),
      "INVALID_PARENT",
      "moves[0].parentId",
    ],
    [
      "into a Rect",
      (s: Scene) => ({ nodeId: s.path.id, parentId: s.rect.id }),
      "INVALID_PARENT",
      "moves[0].parentId",
    ],
    [
      "a Layer into a Group",
      (s: Scene) => ({ nodeId: s.id("B"), parentId: s.id("G") }),
      "INVALID_PARENT",
      "moves[0].parentId",
    ],
    [
      "a Rect to the root",
      (s: Scene) => ({ nodeId: s.rect.id, parentId: null }),
      "INVALID_PARENT",
      "moves[0].parentId",
    ],
    [
      "into an Artboard",
      (s: Scene) => ({ nodeId: s.rect.id, parentId: s.doc.artboards[0]?.id ?? "" }),
      "INVALID_PARENT",
      "moves[0].parentId",
    ],
    [
      "before a Node in another parent",
      (s: Scene) => ({ nodeId: s.path.id, parentId: s.id("G"), before: s.rect.id }),
      "INVALID_INPUT",
      "moves[0].before",
    ],
    [
      "after the Node itself",
      (s: Scene) => ({ nodeId: s.rect.id, parentId: s.a, after: s.rect.id }),
      "INVALID_INPUT",
      "moves[0].after",
    ],
    [
      "index past the end",
      (s: Scene) => ({ nodeId: s.path.id, parentId: s.id("G"), index: 3 }),
      "INVALID_INPUT",
      "moves[0].index",
    ],
    [
      "index plus after",
      (s: Scene) => ({ nodeId: s.path.id, parentId: s.id("G"), index: 0, after: s.id("g1") }),
      "INVALID_INPUT",
      "moves[0].after",
    ],
    [
      "an unknown nodeId",
      () => ({ nodeId: "nope", parentId: null }),
      "NODE_NOT_FOUND",
      "moves[0].nodeId",
    ],
    [
      "an unknown parentId",
      (s: Scene) => ({ nodeId: s.rect.id, parentId: "nope" }),
      "NODE_NOT_FOUND",
      "moves[0].parentId",
    ],
    [
      "an unknown before",
      (s: Scene) => ({ nodeId: s.rect.id, parentId: s.a, before: "nope" }),
      "NODE_NOT_FOUND",
      "moves[0].before",
    ],
  ] as const)("refuses %s", (_, move, code, path) => {
    const s = scene();
    const before = new Map(s.doc.nodes);
    const error = errorOf(() => reparentNodes(s.doc, [move(s)]));
    expect(error).toMatchObject({ code, path, hint: expect.any(String) });
    expect(s.doc.nodes).toEqual(before);
  });

  it("names the failing move, changes nothing without partial, and skips it with partial", () => {
    const { doc, a, path, rect, id, kids } = scene();
    const moves = [
      { nodeId: path.id, parentId: id("G") },
      { nodeId: rect.id, parentId: null },
      { nodeId: id("g1"), parentId: a },
    ];
    const before = new Map(doc.nodes);
    expect(errorOf(() => reparentNodes(doc, moves))).toMatchObject({
      code: "INVALID_PARENT",
      path: "moves[1].parentId",
    });
    expect(doc.nodes).toEqual(before);
    const { nodes, failed } = reparentNodes(doc, moves, { partial: true });
    expect(nodes.map((n) => n.id)).toEqual([path.id, id("g1")]);
    expect(failed).toMatchObject([{ index: 1, code: "INVALID_PARENT", path: "moves[1].parentId" }]);
    expect(kids(a)).toEqual([rect.id, id("g1")]);
  });

  describe("Clipping Paths (ADR-0021, ADR-0053)", () => {
    const clipped = () => {
      const s = scene();
      const { group } = makeMask(s.doc, { clipNodeId: s.id("g2"), contentIds: [s.id("g1")] });
      return { ...s, clipGroup: group.id };
    };

    it("one moved to a Layer loses clipping and keeps its Appearance; the Group is ordinary", () => {
      const { doc, a, id, clipGroup, kids } = clipped();
      const clip = doc.nodes.get(id("g2")) as ShapeNode;
      reparentNodes(doc, [{ nodeId: clip.id, parentId: a }]);
      const moved = doc.nodes.get(clip.id) as ShapeNode;
      expect(moved).not.toHaveProperty("clipping");
      expect(moved.appearance).toEqual(clip.appearance);
      const group = doc.nodes.get(clipGroup) as Node;
      expect(clippingPath(doc, group)).toBeUndefined();
      expect(kids(clipGroup)).toEqual([id("g1")]);
    });

    it("one restacked within its Clip Group keeps clipping", () => {
      const { doc, id, clipGroup, kids } = clipped();
      reparentNodes(doc, [{ nodeId: id("g2"), parentId: clipGroup, index: 0 }]);
      expect(kids(clipGroup)).toEqual([id("g2"), id("g1")]);
      expect(doc.nodes.get(id("g2"))).toMatchObject({ clipping: true });
    });

    it("one moved into a Group that has one leaves exactly one there", () => {
      const s = clipped();
      const [other] = createNodes(s.doc, [
        {
          type: "group",
          parentId: s.a,
          children: [
            { type: "rect", x: 0, y: 0, width: 5, height: 5, clientKey: "c" },
            { type: "rect", x: 1, y: 0, width: 5, height: 5, clientKey: "k" },
          ],
        },
      ]).nodes as [Node];
      const [c, k] = childrenOf(s.doc, other.id);
      const into = makeMask(s.doc, { clipNodeId: (c as Node).id, contentIds: [(k as Node).id] })
        .group.id;
      reparentNodes(s.doc, [{ nodeId: s.id("g2"), parentId: into }]);
      const clips = childrenOf(s.doc, into).filter((n) => "clipping" in n && n.clipping);
      expect(clips.map((n) => n.id)).toEqual([(c as Node).id]);
    });

    it("a whole Clip Group moves with its Clipping Path intact", () => {
      const { doc, a, id, clipGroup } = clipped();
      reparentNodes(doc, [{ nodeId: clipGroup, parentId: a, index: 0 }]);
      expect(clippingPath(doc, doc.nodes.get(clipGroup) as Node)?.id).toBe(id("g2"));
    });

    it("a Node moved into a clipped Layer is clipped wherever it lands; nothing reorders", () => {
      const { doc, a, path, rect, id, kids } = scene();
      makeMask(doc, { layerId: a });
      reparentNodes(doc, [{ nodeId: id("g1"), parentId: a, after: rect.id }]);
      expect(kids(a)).toEqual([path.id, rect.id, id("g1")]);
      expect(clippingPath(doc, doc.nodes.get(a) as Node)?.id).toBe(rect.id);
    });

    it("a Clip Group left holding only its Clipping Path, and an emptied Group, stay", () => {
      const { doc, a, id, clipGroup } = clipped();
      reparentNodes(doc, [{ nodeId: id("g1"), parentId: a }]);
      expect(doc.nodes.has(clipGroup)).toBe(true);
      expect(clippingPath(doc, doc.nodes.get(clipGroup) as Node)?.id).toBe(id("g2"));
      reparentNodes(doc, [{ nodeId: id("g2"), parentId: a }]);
      expect(doc.nodes.has(clipGroup)).toBe(true);
      expect(childrenOf(doc, clipGroup)).toEqual([]);
    });
  });
});

describe("reorderNodes (ADR-0074)", () => {
  /** Layer L holds a b c d e bottom first; Layer M holds Group G, which holds x y z. */
  const scene = () => {
    const { doc, defaultLayerId: l } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const box = (clientKey: string) =>
      ({ type: "rect", x: 0, y: 0, width: 10, height: 10, clientKey }) as const;
    const { keyMap: top } = createNodes(
      doc,
      ["a", "b", "c", "d", "e"].map((k) => ({ ...box(k), parentId: l })),
    );
    const [m] = createNodes(doc, [{ type: "layer", name: "M" }]).nodes as [Node];
    const { keyMap: inner } = createNodes(doc, [
      { type: "group", parentId: m.id, clientKey: "G", children: ["x", "y", "z"].map(box) },
    ]);
    const keyMap: Record<string, string> = { ...top, ...inner, L: l, M: m.id };
    const id = (k: string) => keyMap[k] as string;
    const name = Object.fromEntries(Object.entries(keyMap).map(([k, v]) => [v, k]));
    const kids = (parent: string | null) =>
      childrenOf(doc, parent === null ? null : id(parent)).map((n) => name[n.id]);
    const keys = () => new Map([...doc.nodes.values()].map((n) => [n.id, n.index]));
    const reorder = (ks: string[], op: Parameters<typeof reorderNodes>[2], partial = false) =>
      reorderNodes(doc, ks.map(id), op, { partial });
    return { doc, id, kids, keys, reorder };
  };

  it.each([
    ["front", ["b"], ["a", "c", "d", "e", "b"]],
    ["back", ["d"], ["d", "a", "b", "c", "e"]],
    ["forward", ["b"], ["a", "c", "b", "d", "e"]],
    ["backward", ["d"], ["a", "b", "d", "c", "e"]],
  ] as const)("%s moves one Node in its parent", (op, sel, order) => {
    const { kids, reorder } = scene();
    reorder([...sel], op);
    expect(kids("L")).toEqual(order);
  });

  it.each([
    // Relative order kept whatever order nodeIds names them in.
    ["front", ["d", "b"], ["a", "c", "e", "b", "d"]],
    ["back", ["d", "b"], ["b", "d", "a", "c", "e"]],
    // Apart, each steps past one sibling.
    ["forward", ["d", "b"], ["a", "c", "b", "e", "d"]],
    ["backward", ["d", "b"], ["b", "a", "d", "c", "e"]],
    // A contiguous run moves as a block, past one sibling.
    ["forward", ["b", "c"], ["a", "d", "b", "c", "e"]],
    ["backward", ["c", "d"], ["a", "c", "d", "b", "e"]],
    // A run at the edge stays; the Node apart from it closes up to it.
    ["forward", ["b", "d", "e"], ["a", "c", "b", "d", "e"]],
    ["backward", ["a", "b", "d"], ["a", "b", "d", "c", "e"]],
  ] as const)("%s on %o in one parent keeps their relative order", (op, sel, order) => {
    const { kids, reorder } = scene();
    reorder([...sel], op);
    expect(kids("L")).toEqual(order);
  });

  it("restacks Nodes in two parents each in its own, and never changes a parent", () => {
    const { doc, id, kids, reorder } = scene();
    const { nodes } = reorder(["x", "b"], "front");
    expect(kids("L")).toEqual(["a", "c", "d", "e", "b"]);
    expect(kids("G")).toEqual(["y", "z", "x"]);
    expect(nodes.map((n) => n.id)).toEqual([id("x"), id("b")]);
    expect(doc.nodes.get(id("x"))?.parentId).toBe(id("G"));
  });

  it("changes only the moved Nodes' keys", () => {
    const { id, keys, reorder } = scene();
    const before = keys();
    const { nodes } = reorder(["b", "c"], "forward");
    const after = keys();
    const changed = [...before].filter(([k, v]) => after.get(k) !== v).map(([k]) => k);
    expect(changed.sort()).toEqual([id("b"), id("c")].sort());
    expect(nodes.map((n) => n.id)).toEqual([id("b"), id("c")]);
  });

  it.each([
    ["front", ["d", "e"]],
    ["forward", ["e"]],
    ["back", ["a", "b"]],
    ["backward", ["a"]],
  ] as const)("%s on %o, already at the edge, moves nothing", (op, sel) => {
    const { kids, keys, reorder } = scene();
    const before = keys();
    const { nodes, failed } = reorder([...sel], op);
    expect(nodes).toEqual([]);
    expect(failed).toEqual([]);
    expect(keys()).toEqual(before);
    expect(kids("L")).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("restacks a top-level Layer among the Layers", () => {
    const { kids, reorder } = scene();
    expect(kids(null)).toEqual(["L", "M"]);
    reorder(["M"], "back");
    expect(kids(null)).toEqual(["M", "L"]);
  });

  it("restacks a Sublayer among its parent Layer's children", () => {
    const { doc, id, reorder } = scene();
    const [sub] = createNodes(doc, [{ type: "layer", parentId: id("M"), name: "S" }]).nodes as [
      Node,
    ];
    const kidsOfM = () => childrenOf(doc, id("M")).map((n) => n.id);
    expect(kidsOfM()).toEqual([id("G"), sub.id]);
    reorderNodes(doc, [sub.id], "back");
    expect(kidsOfM()).toEqual([sub.id, id("G")]);
    expect(doc.nodes.get(sub.id)?.parentId).toBe(id("M"));
    reorder(["G"], "backward");
    expect(kidsOfM()).toEqual([id("G"), sub.id]);
  });

  it("moves a Node and its ancestor each among its own siblings", () => {
    const { id, kids, reorder } = scene();
    const { nodes } = reorder(["M", "x"], "back");
    expect(kids(null)).toEqual(["M", "L"]);
    expect(kids("G")).toEqual(["x", "y", "z"]);
    expect(nodes.map((n) => n.id)).toEqual([id("M")]);
    reorder(["M", "y"], "front");
    expect(kids(null)).toEqual(["L", "M"]);
    expect(kids("G")).toEqual(["x", "z", "y"]);
  });

  it("moves a Node named twice once, and returns it once", () => {
    const { id, kids, reorder } = scene();
    const { nodes } = reorder(["b", "b"], "forward");
    expect(kids("L")).toEqual(["a", "c", "b", "d", "e"]);
    expect(nodes.map((n) => n.id)).toEqual([id("b")]);
  });

  it("keeps clipping on a restacked Clipping Path (ADR-0021)", () => {
    const { doc, id, kids } = scene();
    makeMask(doc, { clipNodeId: id("a"), contentIds: [id("b"), id("c")] });
    const clip = doc.nodes.get(id("a")) as Node;
    const group = clip.parentId as string;
    reorderNodes(doc, [id("a")], "front");
    expect(doc.nodes.get(id("a"))).toMatchObject({ clipping: true, parentId: group });
    expect(childrenOf(doc, group).map((n) => n.id)).toEqual([id("b"), id("c"), id("a")]);
  });

  it("refuses an unknown id as NODE_NOT_FOUND at nodeIds[i]; partial skips it", () => {
    const { doc, id, kids } = scene();
    expect(errorOf(() => reorderNodes(doc, [id("a"), "nope"], "front"))).toMatchObject({
      code: "NODE_NOT_FOUND",
      path: "nodeIds[1]",
    });
    expect(kids("L")).toEqual(["a", "b", "c", "d", "e"]);
    const { nodes, failed } = reorderNodes(doc, [id("a"), "nope"], "front", { partial: true });
    expect(nodes.map((n) => n.id)).toEqual([id("a")]);
    expect(failed).toMatchObject([{ index: 1, code: "NODE_NOT_FOUND", path: "nodeIds[1]" }]);
  });
});

describe("duplicateNodes (ADR-0076)", () => {
  /**
   * Layer L holds a b c bottom first, then Clip Group K (art, then its Clipping Path clip); Layer M,
   * above L, holds Group G, which holds x y. Every Node is named after its key.
   */
  const scene = () => {
    const { doc, defaultLayerId: l } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const box = (clientKey: string, x = 0) => ({
      type: "rect" as const,
      name: clientKey,
      x,
      y: 0,
      width: 10,
      height: 10,
      clientKey,
      appearance: { fills: [{ type: "solid" as const, color: "#FF0000" }], strokes: [] },
    });
    const { keyMap: top } = createNodes(doc, [
      ...["a", "b", "c"].map((k, i) => ({ ...box(k, i * 20), parentId: l })),
      { ...box("art", 60), parentId: l },
      { ...box("clip", 65), parentId: l },
    ]);
    const { group } = makeMask(doc, {
      clipNodeId: top.clip as string,
      contentIds: [top.art as string],
    });
    const [m] = createNodes(doc, [{ type: "layer", name: "M" }]).nodes as [Node];
    const { keyMap: inner } = createNodes(doc, [
      {
        type: "group",
        name: "G",
        parentId: m.id,
        clientKey: "G",
        children: [box("x", 100), { ...box("y", 120), type: "ellipse" as const }],
      },
    ]);
    const keyMap: Record<string, string> = { ...top, ...inner, L: l, M: m.id, K: group.id };
    const id = (k: string) => keyMap[k] as string;
    const name = (n: Node) =>
      Object.entries(keyMap).find(([, v]) => v === n.id)?.[0] ?? `${n.name}'`;
    const kids = (parent: string) => childrenOf(doc, id(parent)).map(name);
    const duplicate = (ks: string[], rest: Omit<Parameters<typeof duplicateNodes>[1], "nodeIds">) =>
      duplicateNodes(doc, { nodeIds: ks.map(id), ...rest });
    return { doc, id, kids, duplicate };
  };
  /** The Node without what a copy changes: its id, its parent's id and its key. */
  const body = ({ id: _, parentId: __, index: ___, ...rest }: Node) => rest;

  it("copies a leaf directly above it: a new id, everything else equal", () => {
    const { doc, id, kids, duplicate } = scene();
    updateNodes(doc, [{ nodeId: id("a"), patch: { tags: ["t"], meta: { k: 1 }, opacity: 0.5 } }]);
    const { created, copies } = duplicate(["a"], {});
    expect(created).toHaveLength(1);
    const [copy] = created as [Node];
    expect(copies).toEqual({ [id("a")]: [copy.id] });
    expect(copy.id).not.toBe(id("a"));
    expect(body(copy)).toEqual(body(doc.nodes.get(id("a")) as Node));
    expect(doc.nodes.get(copy.id)).toBe(copy);
    expect(kids("L")).toEqual(["a", "a'", "b", "c", "K"]);
  });

  it("copies a Group with every descendant, all ids new, structure and geometry equal", () => {
    const { doc, id, kids, duplicate } = scene();
    const keys = new Map([...doc.nodes.values()].map((n) => [n.id, n.index]));
    const { created, copies } = duplicate(["G"], {});
    const [g, x, y] = created as [Node, Node, Node];
    expect(copies).toEqual({ [id("G")]: [g.id] });
    expect(created.map((n) => n.id).some((c) => keys.has(c))).toBe(false);
    expect(x.parentId).toBe(g.id);
    expect(y.parentId).toBe(g.id);
    expect(childrenOf(doc, g.id).map((n) => n.id)).toEqual([x.id, y.id]);
    for (const [copy, k] of [
      [g, "G"],
      [x, "x"],
      [y, "y"],
    ] as const) {
      const original = doc.nodes.get(id(k)) as Node;
      expect(body(copy)).toEqual(body(original));
      expect(bounds(doc, copy)).toEqual(bounds(doc, original));
    }
    expect(kids("M")).toEqual(["G", "G'"]);
    // No existing Node's key changed.
    for (const [nodeId, index] of keys) expect(doc.nodes.get(nodeId)?.index).toBe(index);
  });

  it("copies a Node named with its ancestor, or twice, once", () => {
    const { doc, id, duplicate } = scene();
    const size = doc.nodes.size;
    const { created, copies } = duplicate(["x", "G", "G", "y"], {});
    expect(Object.keys(copies)).toEqual([id("G")]);
    expect(created).toHaveLength(3);
    expect(doc.nodes.size).toBe(size + 3);
  });

  it("stacks each copy directly above its own original, in one parent and in two", () => {
    const { kids, duplicate } = scene();
    duplicate(["c", "a", "x"], {});
    expect(kids("L")).toEqual(["a", "a'", "b", "c", "c'", "K"]);
    expect(kids("G")).toEqual(["x", "x'", "y"]);
  });

  it("puts copies from several parents into a target as one block, in paint order", () => {
    const { doc, id, kids, duplicate } = scene();
    // x (in Layer M) paints above b (in Layer L), whatever order nodeIds names them in.
    const { created, copies } = duplicate(["x", "b"], { targetParentId: id("L") });
    expect(kids("L")).toEqual(["a", "b", "c", "K", "b'", "x'"]);
    expect(created.map((n) => n.parentId)).toEqual([id("L"), id("L")]);
    expect(Object.keys(copies)).toEqual([id("b"), id("x")]);
    const x = created.find((n) => n.name === "x") as Node;
    expect(bounds(doc, x)).toEqual(bounds(doc, doc.nodes.get(id("x")) as Node));
  });

  it("puts the block where index, before or after says (the Alt-drag places it after the topmost)", () => {
    const { id, kids, duplicate } = scene();
    duplicate(["a", "b"], { targetParentId: id("L"), after: id("b") });
    expect(kids("L")).toEqual(["a", "b", "a'", "b'", "c", "K"]);
    const next = scene();
    next.duplicate(["y"], { targetParentId: next.id("L"), index: 0 });
    expect(next.kids("L")).toEqual(["y'", "a", "b", "c", "K"]);
    next.duplicate(["c"], { targetParentId: next.id("L"), before: next.id("c") });
    expect(next.kids("L")).toEqual(["y'", "a", "b", "c'", "c", "K"]);
  });

  it("with offset and count 3, steps each copy by one more offset and stacks them upward", () => {
    const { doc, id, kids, duplicate } = scene();
    const { created, copies } = duplicate(["a"], { offset: { x: 5, y: -2 }, count: 3 });
    expect(copies[id("a")]).toEqual(created.map((n) => n.id));
    expect(created.map((n) => bounds(doc, n))).toEqual([
      { x: 5, y: -2, width: 10, height: 10 },
      { x: 10, y: -4, width: 10, height: 10 },
      { x: 15, y: -6, width: 10, height: 10 },
    ]);
    expect(kids("L").slice(0, 4)).toEqual(["a", "a'", "a'", "a'"]);
    expect(
      childrenOf(doc, id("L"))
        .slice(1, 4)
        .map((n) => n.id),
    ).toEqual(copies[id("a")]);
  });

  it("with count 2 into a target, repeats the block for each step", () => {
    const { doc, id, duplicate } = scene();
    const { copies } = duplicate(["b", "a"], { targetParentId: id("M"), count: 2 });
    const [a1, a2] = copies[id("a")] as [string, string];
    const [b1, b2] = copies[id("b")] as [string, string];
    expect(childrenOf(doc, id("M")).map((n) => n.id)).toEqual([id("G"), a1, b1, a2, b2]);
  });

  it("a lone Clipping Path copied beside itself loses clipping; its Clip Group keeps one", () => {
    const { doc, id, kids, duplicate } = scene();
    const [copy] = duplicate(["clip"], {}).created as [Node];
    expect(copy).not.toHaveProperty("clipping");
    expect(kids("K")).toEqual(["art", "clip", "clip'"]);
    expect(clippingPath(doc, doc.nodes.get(id("K")) as Node)?.id).toBe(id("clip"));
  });

  it("a copied Clip Group and a copied clipped Layer keep their Clipping Paths", () => {
    const { doc, id, duplicate } = scene();
    const [group] = duplicate(["K"], {}).created as [Node];
    expect(clippingPath(doc, group)?.name).toBe("clip");
    expect(clippingPath(doc, group)?.id).not.toBe(id("clip"));
    const [n] = createNodes(doc, [{ type: "layer", name: "N" }]).nodes as [Node];
    const art = { type: "rect", parentId: n.id, x: 0, y: 0, width: 10, height: 10 } as const;
    createNodes(doc, [art, { ...art, name: "top" }]);
    makeMask(doc, { layerId: n.id });
    const [layer] = duplicateNodes(doc, { nodeIds: [n.id] }).created as [Node];
    expect(layer).toMatchObject({ type: "layer", parentId: null });
    expect(clippingPath(doc, layer)?.name).toBe("top");
    expect(childrenOf(doc, null).map((c) => c.id)).toEqual([id("L"), id("M"), n.id, layer.id]);
  });

  it("with layerSuffix names every copied Layer's copy, and only Layers", () => {
    const { doc, id, duplicate } = scene();
    const [sub] = createNodes(doc, [{ type: "layer", name: "S", parentId: id("M") }]).nodes as [
      Node,
    ];
    createNodes(doc, [{ type: "layer", name: "", parentId: sub.id }]);
    const { created } = duplicate(["M", "a"], { layerSuffix: " copy" });
    expect(created.map((n) => n.name)).toEqual(["M copy", "G", "x", "y", "S copy", "", "a"]);
    expect(doc.nodes.get(id("M"))?.name).toBe("M");
  });

  it("keeps an Image's src and file, and a Live Shape's parameters", () => {
    const { doc, id } = scene();
    const src = "a".repeat(64);
    doc.images.set(src, { mime: "image/png", width: 24, height: 16 });
    const [image] = createNodes(doc, [
      { type: "image", parentId: id("L"), src, file: "photo.png", x: 0, y: 0 },
      { type: "star", parentId: id("L"), cx: 0, cy: 0, outerRadius: 10, innerRadius: 4, points: 7 },
    ]).nodes as [Node, Node];
    const star = childrenOf(doc, id("L")).at(-1) as Node;
    const { created } = duplicateNodes(doc, { nodeIds: [image.id, star.id] });
    expect(created.map(body)).toEqual([body(image), body(star)]);
  });

  it.each([
    ["a Layer into a Group", ["M"], "G"],
    ["a Group into itself", ["G"], "G"],
    ["a Group into its descendant's parent chain", ["M"], "M"],
    ["into a leaf", ["a"], "b"],
  ])("refuses %s with INVALID_PARENT, writing nothing", (_, ks, target) => {
    const { doc, id, duplicate } = scene();
    const size = doc.nodes.size;
    expect(errorOf(() => duplicate(ks, { targetParentId: id(target) }))).toMatchObject({
      code: "INVALID_PARENT",
      path: "targetParentId",
    });
    expect(doc.nodes.size).toBe(size);
  });

  it("names the unknown id's place, and refuses a position without a target", () => {
    const { id, duplicate, doc } = scene();
    expect(errorOf(() => duplicateNodes(doc, { nodeIds: [id("a"), "nope"] }))).toMatchObject({
      code: "NODE_NOT_FOUND",
      path: "nodeIds[1]",
    });
    expect(errorOf(() => duplicate(["a"], { targetParentId: "nope" }))).toMatchObject({
      code: "NODE_NOT_FOUND",
      path: "targetParentId",
    });
    expect(errorOf(() => duplicate(["a"], { after: id("b") }))).toMatchObject({
      code: "INVALID_INPUT",
      path: "after",
    });
    expect(
      errorOf(() => duplicate(["a"], { targetParentId: id("L"), after: id("x") })),
    ).toMatchObject({ code: "INVALID_INPUT", path: "after" });
  });
});

describe("Area Type in a closed path (ADR-0078)", () => {
  /** A Document with an ellipse, a star, a closed path and the refused kinds, each turned. */
  const scene = () => {
    const { doc, defaultLayerId: parentId } = newDoc();
    const turn = [0.8, 0.6, -0.6, 0.8, 10, 5];
    const { keyMap } = createNodes(doc, [
      { type: "rect", parentId, clientKey: "below", x: 0, y: 0, width: 5, height: 5 },
      { type: "ellipse", parentId, clientKey: "ellipse", x: 0, y: 0, width: 80, height: 60 },
      {
        type: "star",
        parentId,
        clientKey: "star",
        cx: 50,
        cy: 50,
        outerRadius: 40,
        innerRadius: 20,
        points: 5,
      },
      { type: "path", parentId, clientKey: "path", d: "M 0 0 L 90 0 L 90 40 L 0 40 Z" },
      { type: "path", parentId, clientKey: "open", d: "M 0 0 L 90 0 L 90 40" },
      { type: "line", parentId, clientKey: "line", x1: 0, y1: 0, x2: 10, y2: 10 },
      { type: "spiral", parentId, clientKey: "spiral", cx: 0, cy: 0, radius: 20 },
      {
        type: "ellipse",
        parentId,
        clientKey: "arc",
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        startAngle: 0,
        endAngle: 180,
        arcType: "open",
      },
      { type: "group", parentId, clientKey: "group" },
      { type: "text", parentId, clientKey: "text", x: 0, y: 0, content: "t" },
      { type: "rect", parentId, clientKey: "above", x: 0, y: 0, width: 5, height: 5 },
    ] as never);
    const id = (k: string) => keyMap[k] as string;
    for (const k of ["ellipse", "star", "path"]) {
      transformNodes(doc, { nodeIds: [id(k)], matrix: turn } as never);
    }
    return { doc, parentId, id, turn };
  };
  const text = (parentId: string, extra: object) =>
    ({
      type: "text",
      kind: "area",
      parentId,
      content: "Flowed words in a shape",
      ...extra,
    }) as never;

  it.each(["ellipse", "star", "path"])(
    "flows in a %s by frameNodeId: its place, transform and outline, and deletes it",
    (k) => {
      const { doc, parentId, id } = scene();
      const source = doc.nodes.get(id(k)) as ShapeNode;
      const place = childrenOf(doc, parentId).indexOf(source);
      const { nodes, deletedIds } = createNodes(doc, [text(parentId, { frameNodeId: id(k) })]);
      const [t] = nodes as [Node & { frame?: string }];
      expect(deletedIds).toEqual([id(k)]);
      expect(doc.nodes.has(id(k))).toBe(false);
      expect(t).toMatchObject({
        kind: "area",
        parentId,
        index: source.index,
        transform: source.transform,
      });
      const outline = source.type === "path" ? parsePath(source.d, "d") : shapeSegments(source);
      expect(t.frame).toBe(formatPath(outline));
      // Its bounds are the stored frame's, kept to 3 decimals, and it takes the source's place.
      const b = pathBounds(parsePath(t.frame as string, "d"));
      expect(t).toMatchObject({ x: b?.x, y: b?.y, width: b?.width, height: b?.height });
      expect(childrenOf(doc, parentId).indexOf(t)).toBe(place);
      const was = bounds({ ...doc, nodes: new Map([[source.id, source]]) }, source);
      for (const key of ["x", "y", "width", "height"] as const) {
        expect(bounds(doc, t)?.[key]).toBeCloseTo(was?.[key] as number, 3);
      }
    },
  );

  it.each([
    ["open", "INVALID_INPUT", /open/],
    ["line", "INVALID_INPUT", /open/],
    ["spiral", "INVALID_INPUT", /open/],
    ["arc", "INVALID_INPUT", /open/],
    ["group", "INVALID_INPUT", /closed Live Shape or Path/],
    ["text", "INVALID_INPUT", /closed Live Shape or Path/],
    ["missing", "NODE_NOT_FOUND", /closed Live Shape or Path/],
  ])("refuses frameNodeId %s with %s, writing nothing", (k, code, hint) => {
    const { doc, parentId, id } = scene();
    const before = new Map(doc.nodes);
    const error = errorOf(() =>
      createNodes(doc, [text(parentId, { frameNodeId: id(k) ?? "missing" })]),
    );
    expect(error).toMatchObject({
      code,
      path: "nodes[0].frameNodeId",
      hint: expect.stringMatching(hint),
    });
    expect(doc.nodes).toEqual(before);
  });

  it("refuses a Clipping Path, a locked frame, another parent and a frame used twice", () => {
    const { doc, parentId, id } = scene();
    const refuses = (inputs: object[], path: string, hint: RegExp) => {
      const before = new Map(doc.nodes);
      expect(errorOf(() => createNodes(doc, inputs as never))).toMatchObject({
        code: "INVALID_INPUT",
        path,
        hint: expect.stringMatching(hint),
      });
      expect(doc.nodes).toEqual(before);
    };
    updateNodes(doc, [{ nodeId: id("path"), patch: { locked: true } }]);
    refuses([text(parentId, { frameNodeId: id("path") })], "nodes[0].frameNodeId", /Unlock/);
    const [layer] = createNodes(doc, [{ type: "layer" }]).nodes as [Node];
    refuses([text(layer.id, { frameNodeId: id("star") })], "nodes[0].frameNodeId", /parent/);
    refuses(
      [text(parentId, { frameNodeId: id("star") }), text(parentId, { frameNodeId: id("star") })],
      "nodes[1].frameNodeId",
      /frames one text/,
    );
    makeMask(doc, { clipNodeId: id("ellipse"), contentIds: [id("below")] });
    const clip = doc.nodes.get(id("ellipse")) as Node;
    refuses(
      [text(clip.parentId as string, { frameNodeId: id("ellipse") })],
      "nodes[0].frameNodeId",
      /mask_release/,
    );
  });

  it("refuses an Image, a Layer and an evenodd Compound Path whose holes a nonzero frame would fill", () => {
    const { doc, parentId } = scene();
    const src = "a".repeat(64);
    doc.images.set(src, { mime: "image/png", width: 24, height: 16 });
    // Both rings wind the same way: evenodd leaves the hole, nonzero would fill it.
    const ring = "M 0 0 L 90 0 L 90 90 L 0 90 Z M 30 30 L 60 30 L 60 60 L 30 60 Z";
    const [image, holed] = createNodes(doc, [
      { type: "image", parentId, src, x: 0, y: 0 },
      { type: "path", parentId, d: ring, fillRule: "evenodd" },
    ] as never).nodes as [Node, Node];
    const refused = (frameNodeId: string, at: string, hint: RegExp) => {
      const before = new Map(doc.nodes);
      expect(errorOf(() => createNodes(doc, [text(at, { frameNodeId })]))).toMatchObject({
        code: "INVALID_INPUT",
        path: "nodes[0].frameNodeId",
        hint: expect.stringMatching(hint),
      });
      expect(doc.nodes).toEqual(before);
    };
    refused(image.id, parentId, /closed Live Shape or Path/);
    refused(parentId, parentId, /closed Live Shape or Path/);
    refused(holed.id, parentId, /Reverse each hole/);
  });

  it("flows in an evenodd Compound Path whose hole winds against its outline, where both rules agree", () => {
    const { doc, parentId } = scene();
    const d = "M 0 0 L 90 0 L 90 90 L 0 90 Z M 30 30 L 30 60 L 60 60 L 60 30 Z";
    const [holed] = createNodes(doc, [{ type: "path", parentId, d, fillRule: "evenodd" }] as never)
      .nodes as [Node];
    const [t] = createNodes(doc, [text(parentId, { frameNodeId: holed.id })]).nodes;
    expect(t).toMatchObject({ frame: d, x: 0, y: 0, width: 90, height: 90 });
  });

  it("stores a curved frame's bounds to 3 decimals, as a saved file reads them back", () => {
    const { doc, parentId } = scene();
    const frame = "M 0 40 C 0 -13 70 -17 100 40 L 100 80 L 0 80 Z";
    const [t] = createNodes(doc, [text(parentId, { frame })]).nodes as [Node];
    const exact = pathBounds(parsePath(frame, "d")) as { y: number };
    expect(exact.y).not.toBe(Math.round(exact.y * 1000) / 1000);
    expect(t).toMatchObject({ y: Math.round(exact.y * 1000) / 1000 });
    const read = new Map(parseDocument(serializeDocument(doc)).nodes.map((n) => [n.id, n]));
    expect(read).toEqual(doc.nodes);
  });

  it("paints and clips by a shaped frame's outline, not its bounds", () => {
    const { doc, parentId } = scene();
    const frame = "M 0 0 L 100 0 L 50 80 Z";
    const [group, t, content] = createNodes(doc, [
      {
        type: "group",
        parentId,
        children: [
          { type: "text", kind: "area", frame, content: "Words" },
          { type: "rect", x: 0, y: 0, width: 200, height: 200 },
        ],
      },
    ] as never).nodes as [Node, Node, Node];
    expect(paintedLeaves(doc, group)[0]?.segments.map((s) => s.cmd)).toEqual(["M", "L", "L", "Z"]);
    // Turned an eighth, the triangle's bounds are smaller than its bounding rectangle's.
    const r = Math.SQRT1_2;
    transformNodes(doc, { nodeIds: [t.id], matrix: [r, r, -r, r, 0, 0] } as never);
    const turned = doc.nodes.get(t.id) as Node & { transform: Matrix };
    const want = pathBounds(transformSegments(parsePath(frame, "d"), turned.transform)) as Rect;
    const rectangle = parsePath("M 0 0 L 100 0 L 100 80 L 0 80 Z", "d");
    const box = pathBounds(transformSegments(rectangle, turned.transform)) as Rect;
    const { group: clipped } = makeMask(doc, { clipNodeId: t.id, contentIds: [content.id] });
    const got = bounds(doc, clipped) as Rect;
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(got[key]).toBeCloseTo(want[key], 3);
    }
    expect(box.width - want.width).toBeGreaterThan(10);
  });

  it("takes frame path data directly, refusing it open, beside width, or with frameNodeId", () => {
    const { doc, parentId, id } = scene();
    const [t] = createNodes(doc, [text(parentId, { frame: "M 10 10 L 60 10 L 35 50 Z" })])
      .nodes as [Node];
    expect(t).toMatchObject({
      frame: "M 10 10 L 60 10 L 35 50 Z",
      x: 10,
      y: 10,
      width: 50,
      height: 40,
    });
    expect(
      errorOf(() => createNodes(doc, [text(parentId, { frame: "M 0 0 L 9 9" })])),
    ).toMatchObject({
      code: "INVALID_INPUT",
      path: "nodes[0].frame",
    });
    expect(errorOf(() => createNodes(doc, [text(parentId, { frame: "M 0 0 Q" })]))).toMatchObject({
      code: "INVALID_PATH",
    });
    // The input schema refuses the mixes: MCP answers them INVALID_INPUT at these paths.
    const issue = (extra: object) =>
      NodeInput.safeParse(text(parentId, { frame: "M 0 0 L 9 0 L 9 9 Z", ...extra })).error
        ?.issues[0];
    expect(issue({ width: 9 })).toMatchObject({
      path: ["width"],
      message: expect.stringMatching(/drop width/),
    });
    expect(issue({ x: 1 })).toMatchObject({ path: ["x"] });
    expect(issue({ frameNodeId: id("star") })).toMatchObject({ path: ["frameNodeId"] });
    expect(NodeInput.safeParse(text(parentId, {})).error?.issues[0]).toMatchObject({
      path: ["x"],
    });
    expect(doc.nodes.has(id("star"))).toBe(true);
  });

  it("reshapes by frame, refuses the bounds on a shaped frame, and frame: null keeps them as a rectangle", () => {
    const { doc, parentId } = scene();
    const [t] = createNodes(doc, [text(parentId, { frame: "M 10 10 L 60 10 L 35 50 Z" })])
      .nodes as [Node];
    const [moved] = updateNodes(doc, [
      { nodeId: t.id, patch: { frame: "M 0 0 L 100 0 L 50 80 Z" } },
    ]).nodes as [Node];
    expect(moved).toMatchObject({
      frame: "M 0 0 L 100 0 L 50 80 Z",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
    });
    expect(bounds(doc, moved)).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    expect(errorOf(() => updateNodes(doc, [{ nodeId: t.id, patch: { width: 10 } }]))).toMatchObject(
      {
        code: "INVALID_PATCH",
        path: "updates[0].patch.width",
        hint: expect.stringMatching(/frame/),
      },
    );
    expect(
      errorOf(() => updateNodes(doc, [{ nodeId: t.id, patch: { frame: "M 0 0 L 5 5" } }])),
    ).toMatchObject({
      code: "INVALID_PATCH",
      path: "updates[0].patch.frame",
    });
    const [rect] = updateNodes(doc, [{ nodeId: t.id, patch: { frame: null } }]).nodes as [Node];
    expect(rect).not.toHaveProperty("frame");
    expect(rect).toMatchObject({ x: 0, y: 0, width: 100, height: 80 });
    const [wide] = updateNodes(doc, [{ nodeId: t.id, patch: { width: 120 } }]).nodes as [Node];
    expect(wide).toMatchObject({ width: 120 });
  });
});

describe("Convert to Area Type and Point Type (ADR-0079)", () => {
  type Text = Extract<Node, { type: "text" }>;
  const make = (extra: object) => {
    const { doc, defaultLayerId } = newDoc();
    const [t] = createNodes(doc, [
      { type: "text", parentId: defaultLayerId, x: 10, y: 30, ...extra } as never,
    ]).nodes as [Text];
    return { doc, t };
  };
  const convert = (doc: Document, id: string, patch: Record<string, unknown>) =>
    updateNodes(doc, [{ nodeId: id, patch }]);
  /** The drawn characters and their overrides; hard returns and hung spaces draw nothing. */
  const drawn = (t: Text) => glyphs(t).filter((g) => !/\s/.test(g.char));
  /** The same characters and overrides, each origin within the 3 decimals a conversion keeps. */
  const expectSame = (a: Text, b: Text) => {
    const [ga, gb] = [drawn(a), drawn(b)];
    const plain = (g: Glyph[]) => g.map(({ x: _, y: __, ...rest }) => rest);
    expect(plain(ga)).toEqual(plain(gb));
    ga.forEach((g, i) => {
      expect(g.x).toBeCloseTo((gb[i] as Glyph).x, 3);
      expect(g.y).toBeCloseTo((gb[i] as Glyph).y, 3);
    });
  };
  const ranges = [
    { start: 0, end: 3, fill: "#ff0000" },
    { start: 7, end: 9, baselineShift: 3 },
    { start: 12, end: 14, rotation: 20, fontSize: 18 },
  ];

  it.each(["left", "center", "right", "justify"])(
    "Point to Area keeps every glyph of tracked, ranged, %s multi-line text",
    (alignment) => {
      const content = "First line\nthe second, longer line\n\nlast";
      const { doc, t } = make({ content, tracking: 50, leading: 18, alignment, ranges });
      const { nodes, warnings } = convert(doc, t.id, { kind: "area" });
      const a = doc.nodes.get(t.id) as Text;
      expect(nodes).toEqual([a]);
      expect(warnings).toEqual([]);
      expect(a).toMatchObject({ kind: "area", content, transform: t.transform });
      expect(a.ranges).toEqual(t.ranges);
      expectSame(a, t);
      // Every line's box fits: 4 lines of 18 pt.
      expect(a.height).toBeCloseTo(72);
    },
  );

  it("Point to Area stacks lines of mixed sizes under Auto leading", () => {
    const { doc, t } = make({
      content: "ab\ncd\nef",
      ranges: [{ start: 3, end: 4, fontSize: 30 }],
    });
    convert(doc, t.id, { kind: "area" });
    const a = doc.nodes.get(t.id) as Text;
    expectSame(a, t);
    expect(a.height).toBeCloseTo(14.4 + 36 + 14.4);
  });

  it.each([
    ["first", "ab\ncd\nef", [{ start: 0, end: 2, fontSize: 30 }], undefined],
    ["last", "ab\ncd", [{ start: 3, end: 5, fontSize: 30 }], undefined],
    ["last, under a set leading", "ab\ncd\nef", [{ start: 6, end: 8, fontSize: 60 }], 10],
    ["middle, with small lines after", "ab\ncd\nef\ngh", [{ start: 3, end: 5, fontSize: 90 }], 10],
  ])(
    "Point to Area holds a larger size on the %s line, and converts back unchanged",
    (_, content, ranges, leading) => {
      const { doc, t } = make({ content, ranges, leading });
      const { warnings } = convert(doc, t.id, { kind: "area" });
      const a = doc.nodes.get(t.id) as Text;
      expect(warnings).toEqual([]);
      expect(layoutText(a).overflow).toBe("");
      expectSame(a, t);
      expect(convert(doc, t.id, { kind: "point" }).warnings).toEqual([]);
      expect(doc.nodes.get(t.id)).toEqual(t);
    },
  );

  it("Point to Area rounds the width up past a floating-point quotient below it", () => {
    const { doc, t } = make({
      content: "MMMM",
      alignment: "right",
      leading: 10,
      ranges: [{ start: 0, end: 4, tracking: 200 }],
    });
    convert(doc, t.id, { kind: "area" });
    const a = doc.nodes.get(t.id) as Text;
    expect(layoutText(a)).toMatchObject({ lines: [{ text: "MMMM" }], overflow: "" });
    expectSame(a, t);
  });

  it.each([
    ["Auto", undefined],
    ["a set", 20],
  ])(
    "Point to Area keeps every glyph of CJK in a fallback family under %s leading, and back (ADR-0080)",
    (_, leading) => {
      const content = "Hello 中文 world\nsecond 日本語 line\nlast";
      const { doc, t } = make({ content, leading, ranges: [{ start: 6, end: 8, fontSize: 40 }] });
      expect(convert(doc, t.id, { kind: "area" }).warnings).toEqual([]);
      const a = doc.nodes.get(t.id) as Text;
      expect(layoutText(a).overflow).toBe("");
      expectSame(a, t);
      expect(convert(doc, t.id, { kind: "point" }).warnings).toEqual([]);
      expect(doc.nodes.get(t.id)).toEqual(t);
    },
  );

  it("Area to Point keeps every glyph of soft-wrapped CJK in a fallback family (ADR-0080)", () => {
    const content = "Latin words 中文字 and 日本語の文 wrap here";
    const ranges = [{ start: 12, end: 14, fontSize: 20 }];
    const { doc, t } = make({ kind: "area", width: 70, height: 200, content, ranges });
    expect(layoutText(t).lines.length).toBeGreaterThan(3);
    expect(convert(doc, t.id, { kind: "point" }).warnings).toEqual([]);
    expectSame(doc.nodes.get(t.id) as Text, t);
  });

  // Each ends the first line where its unit breaks between characters (ADR-0084).
  it.each([
    ["U+00A0", "aaaaaaaaa\u00A0bbbb"],
    ["U+2007", "aaaaaaaa\u2007bbbb"],
    ["U+202F", "aaaaaaaaa\u202Fbbbb"],
    ["U+FEFF", "aaaaaaaaa\uFEFFbbbb"],
  ])(
    "Area to Point keeps %s where it ends a line, only inserting the returns (ADR-0087)",
    (_, content) => {
      const { doc, t } = make({ kind: "area", width: 60, height: 200, content });
      expect(layoutText(t).lines[0]?.text).toBe(content.slice(0, content.length - 4));
      expect(convert(doc, t.id, { kind: "point" }).warnings).toEqual([]);
      const p = doc.nodes.get(t.id) as Text;
      expect(p.content.replaceAll("\n", "")).toBe(content);
      expectSame(p, t);
    },
  );

  it("Area to Point keeps a no-break space before a soft wrap's space, and inside a unit (ADR-0087)", () => {
    for (const [content, want] of [
      ["xxxxx aa\u00A0 bbbbbbbb", "xxxxx aa\u00A0\nbbbbbbbb"],
      ["xxxxx aa\u00A0bbbbbbbb", "xxxxx\naa\u00A0bbbbbb\nbb"],
    ]) {
      const { doc, t } = make({ kind: "area", width: 60, height: 200, content });
      expect(convert(doc, t.id, { kind: "point" }).warnings).toEqual([]);
      expect(doc.nodes.get(t.id)).toMatchObject({ kind: "point", content: want });
      expectSame(doc.nodes.get(t.id) as Text, t);
    }
  });

  it("Area to Point keeps a soft hyphen where it ends a line, only inserting the return (ADR-0094)", () => {
    const content = "xxxx x\u00ADyyyyyy";
    const { doc, t } = make({ kind: "area", width: 45, height: 200, content });
    expect(convert(doc, t.id, { kind: "point" }).warnings).toEqual([]);
    expect(doc.nodes.get(t.id)).toMatchObject({ kind: "point", content: "xxxx x\u00AD\nyyyyyy" });
    expectSame(doc.nodes.get(t.id) as Text, t);
  });

  it("a trailing hard return survives Point to Area and back", () => {
    const { doc, t } = make({ content: "ab\n" });
    convert(doc, t.id, { kind: "area" });
    expect(convert(doc, t.id, { kind: "point" }).warnings).toEqual([]);
    expect(doc.nodes.get(t.id)).toEqual(t);
  });

  it("Area to Point deletes the hard return before a paragraph of overflow, counting it", () => {
    const { doc, t } = make({ kind: "area", width: 60, height: 16, content: "ab\ncd" });
    const { warnings } = convert(doc, t.id, { kind: "point" });
    expect(doc.nodes.get(t.id)).toMatchObject({ kind: "point", content: "ab" });
    expect(warnings).toEqual([
      { code: "TEXT_DISCARDED", nodeId: t.id, message: expect.stringMatching(/^3 characters/) },
    ]);
  });

  it("Area to Point keeps an empty paragraph that is all that shows, deleting the overflow", () => {
    const { doc, t } = make({
      kind: "area",
      width: 90,
      height: 35,
      fontSize: 20,
      content: "\nlazy xyz",
      ranges: [{ start: 0, end: 5, fill: "#ff0000" }],
    });
    const { warnings } = convert(doc, t.id, { kind: "point" });
    expect(doc.nodes.get(t.id)).toMatchObject({
      kind: "point",
      content: "\n",
      ranges: [{ start: 0, end: 1, fill: "#ff0000" }],
    });
    expect(warnings).toEqual([
      { code: "TEXT_DISCARDED", nodeId: t.id, message: expect.stringMatching(/^8 characters/) },
    ]);
  });

  it("Point to Area and back returns a centred text unchanged", () => {
    const { doc, t } = make({ content: "the W", fontSize: 24, alignment: "center", x: 100 });
    convert(doc, t.id, { kind: "area" });
    const a = doc.nodes.get(t.id) as Text;
    // An even thousandth, so the frame's middle is a stored number.
    expect(Math.round((a.width as number) * 1000) % 2).toBe(0);
    expectSame(a, t);
    convert(doc, t.id, { kind: "point" });
    expect(doc.nodes.get(t.id)).toEqual(t);
  });

  it("Point to Area of empty or all-space lines is fontSize wide", () => {
    const { doc, t } = make({ content: "\n  \n", fontSize: 20 });
    convert(doc, t.id, { kind: "area" });
    expect(doc.nodes.get(t.id)).toMatchObject({ kind: "area", x: 10, width: 20 });
  });

  it("Area to Point turns soft wraps into hard returns and keeps every glyph", () => {
    const content = "The quick brown fox jumps over\nthe lazy dog, again and again";
    const { doc, t } = make({
      kind: "area",
      width: 60,
      height: 200,
      content,
      tracking: 30,
      ranges,
    });
    const { warnings } = convert(doc, t.id, { kind: "point" });
    const p = doc.nodes.get(t.id) as Text;
    expect(warnings).toEqual([]);
    expect(p.kind).toBe("point");
    expect(p).not.toHaveProperty("width");
    expect(p).not.toHaveProperty("height");
    // Each soft wrap's last space became a hard return, so the lengths and ranges match.
    expect(p.content).toBe("The quick\nbrown\nfox jumps\nover\nthe lazy\ndog, again\nand again");
    expect(p.content.replace(/\n/g, " ")).toBe(content.replace(/\n/g, " "));
    expect(p.ranges).toEqual(t.ranges);
    expectSame(p, t);
  });

  it.each(["center", "right"])("Area to Point keeps %s lines about the frame", (alignment) => {
    const { doc, t } = make({
      kind: "area",
      width: 80,
      height: 100,
      alignment,
      content: "one two three four five",
    });
    convert(doc, t.id, { kind: "point" });
    const p = doc.nodes.get(t.id) as Text;
    expect(p.x).toBeCloseTo(10 + (alignment === "center" ? 40 : 80), 3);
    expectSame(p, t);
  });

  it("Area to Point inserts a hard return at a CJK break and shifts the ranges after it", () => {
    const content = "中文字符在这里换行不需要空格";
    const { doc, t } = make({
      kind: "area",
      fontFamily: "Noto Sans SC",
      width: 50,
      height: 100,
      content,
      ranges: [{ start: 2, end: 8, fill: "#00ff00" }],
    });
    convert(doc, t.id, { kind: "point" });
    const p = doc.nodes.get(t.id) as Text;
    expect(p.content.split("\n").join("")).toBe(content);
    const breaks = p.content.split("\n").length - 1;
    expect(breaks).toBeGreaterThan(1);
    expect([...p.content].length).toBe([...content].length + breaks);
    expectSame(p, t);
  });

  it("Area to Point inserts a hard return where a unit wider than the frame broke, and back is unchanged", () => {
    // A 40-H word in a 180-wide frame breaks into pieces of 13, 13, 13 and 1 (ADR-0084).
    const content = `HHH ${"H".repeat(40)} HHH`;
    const { doc, t } = make({
      kind: "area",
      width: 180,
      height: 300,
      fontSize: 20,
      content,
      ranges: [{ start: 10, end: 30, fill: "#00ff00" }],
    });
    const { warnings } = convert(doc, t.id, { kind: "point" });
    const p = doc.nodes.get(t.id) as Text;
    expect(warnings).toEqual([]);
    const h13 = "H".repeat(13);
    expect(p.content).toBe(`HHH\n${h13}\n${h13}\n${h13}\nH HHH`);
    expect(p.ranges).toEqual([{ start: 10, end: 31, fill: "#00ff00" }]);
    expectSame(p, t);
    convert(doc, t.id, { kind: "area" });
    convert(doc, t.id, { kind: "point" });
    expect(doc.nodes.get(t.id)).toEqual(p);
  });

  it("Area to Point deletes the overflow, clipping ranges, and warns TEXT_DISCARDED", () => {
    const content = "one two three four five six";
    const { doc, t } = make({
      kind: "area",
      width: 50,
      height: 30,
      content,
      ranges: [
        { start: 4, end: 12, fill: "#ff0000" },
        { start: 16, end: 24, baselineShift: 2 },
        { start: 20, end: 25, rotation: 10 },
      ],
    });
    const before = structuredClone(t);
    const { warnings } = convert(doc, t.id, { kind: "point" });
    const p = doc.nodes.get(t.id) as Text;
    expect(p.content).toBe("one two\nthree four ");
    expect(p.ranges).toEqual([
      { start: 4, end: 12, fill: "#ff0000" },
      { start: 16, end: 19, baselineShift: 2 },
    ]);
    expect(warnings).toEqual([
      { code: "TEXT_DISCARDED", nodeId: t.id, message: expect.stringMatching(/^8 characters/) },
    ]);
    expectSame(p, t);
    // The stored Node is untouched, so a Transaction's before restores it.
    expect(t).toEqual(before);
  });

  it("Area to Point left-aligns a shaped frame's lines at the first line's x", () => {
    const frame = "M 0 0 L 100 0 L 50 80 Z";
    const { doc, t } = make({
      kind: "area",
      frame,
      content: "Flowed words in a shape of text",
      x: undefined,
      y: undefined,
    });
    convert(doc, t.id, { kind: "point" });
    const p = doc.nodes.get(t.id) as Text;
    expect(p).not.toHaveProperty("frame");
    const first = glyphs(t)[0];
    expect(p.x).toBeCloseTo(first?.x as number, 3);
    expect(p.y).toBeCloseTo(first?.y as number, 3);
    // Each line's first glyph, keyed by its baseline: several lines, all starting at one x.
    const starts = new Map(
      glyphs(p)
        .map((g) => [g.y, g.x] as const)
        .reverse(),
    );
    expect(starts.size).toBeGreaterThan(2);
    expect(new Set(starts.values())).toEqual(new Set([p.x]));
  });

  it("Area to Point reads a shaped frame's bands sized by their lines (#200)", () => {
    // A 40 pt word that ends the first band sizes it, so three words fit where four would, and the
    // next band steps by the 40 pt word's leading.
    const H = "HHH";
    const content = [H, H, H, H, H, H, H, H, H].join(" ");
    const { doc, t } = make({
      kind: "area",
      frame: "M 20 40 L 200 40 L 200 340 L 120 340 Z",
      content,
      fontSize: 20,
      ranges: [{ start: 16, end: 19, fontSize: 40 }],
      x: undefined,
      y: undefined,
    });
    convert(doc, t.id, { kind: "point" });
    const p = doc.nodes.get(t.id) as Text;
    expect(p.content.split("\n").slice(0, 2)).toEqual(["HHH HHH HHH", "HHH HHH"]);
    expect(p.ranges).toEqual([{ start: 16, end: 19, fontSize: 40 }]);
    expect([p.x, p.y]).toEqual([34.4, 74.166]);
    const baselines = [...new Set(glyphs(p).map((g) => g.y))];
    expect(baselines.slice(0, 3).map((y) => +y.toFixed(2))).toEqual([74.17, 122.17, 146.17]);
    // Every line starts at the first line's x, as ADR-0079 left-aligns a shaped frame's lines.
    expect(new Set(layoutText(p).lines.map((l) => l.x))).toEqual(new Set([p.x]));
  });

  it("refuses to convert when no line shows", () => {
    const { doc, t } = make({ kind: "area", width: 40, height: 2, content: "hidden" });
    expect(errorOf(() => convert(doc, t.id, { kind: "point" }))).toMatchObject({
      code: "INVALID_PATCH",
      path: "updates[0].patch.kind",
    });
  });

  it("refuses layout keys beside kind, converts with name, and a same kind is a no-op", () => {
    const { doc, t } = make({ kind: "area", width: 40, height: 30, content: "hi" });
    expect(errorOf(() => convert(doc, t.id, { kind: "point", width: 10 }))).toMatchObject({
      code: "INVALID_PATCH",
      path: "updates[0].patch.width",
      hint: expect.stringMatching(/Convert first/),
    });
    // The same kind too, so the rule does not depend on the Node's kind.
    expect(errorOf(() => convert(doc, t.id, { kind: "area", content: "x" }))).toMatchObject({
      code: "INVALID_PATCH",
      path: "updates[0].patch.content",
      hint: expect.stringMatching(/Convert first/),
    });
    expect(doc.nodes.get(t.id)).toEqual(t);
    convert(doc, t.id, { kind: "area" });
    expect(doc.nodes.get(t.id)).toEqual(t);
    convert(doc, t.id, { kind: "point", name: "Body", opacity: 0.5 });
    expect(doc.nodes.get(t.id)).toMatchObject({ kind: "point", name: "Body", opacity: 0.5 });
  });
});

describe("Auto Size (ADR-0092)", () => {
  type Text = Extract<Node, { type: "text" }>;
  const make = (extra: object) => {
    const { doc, defaultLayerId } = newDoc();
    const [t] = createNodes(doc, [
      {
        type: "text",
        kind: "area",
        parentId: defaultLayerId,
        x: 10,
        y: 20,
        width: 100,
        autoSize: true,
        content: "one",
        ...extra,
      } as never,
    ]).nodes as [Text];
    return { doc, t, defaultLayerId };
  };
  const update = (doc: Document, id: string, patch: Record<string, unknown>) => {
    updateNodes(doc, [{ nodeId: id, patch }]);
    return doc.nodes.get(id) as Text;
  };
  // Lines that never wrap: Convert to Area Type's frame reaches the same lowest bottom.
  const pointHeight = (extra: object) =>
    areaFrame({ x: 0, y: 0, fontFamily: "Source Sans 3", fontSize: 12, content: "", ...extra })
      .height;

  it.each([
    [{ content: "one\ntwo" }, 28.8],
    [{ content: "one\ntwo\nthree", leading: 20 }, 60],
    [{ content: "one\n" }, 14.4],
    [{ content: "  " }, 14.4],
    [{ content: " \n " }, 28.8],
  ])("stores the fitted height of %j, the frame being its bounds", (extra, height) => {
    const { doc, t } = make(extra);
    expect(t).toMatchObject({ autoSize: true, x: 10, y: 20, width: 100, height });
    expect(near(bounds(doc, t))).toEqual({ x: 10, y: 20, width: 100, height });
  });

  it("fits mixed Character Range sizes and a set leading as Convert to Area Type stacks them", () => {
    const ranges = [
      { start: 0, end: 3, fontSize: 30 },
      { start: 8, end: 11, fontSize: 6 },
    ];
    for (const leading of [undefined, 16]) {
      const content = "big\nsmall\ntiny";
      const { t } = make({ content, ranges, ...(leading && { leading }) });
      expect(t.height).toBe(pointHeight({ content, ranges, leading }));
      expect(layoutText(t).overflow).toBe("");
    }
  });

  it("refits on every edit to the layout, staying on", () => {
    const { doc, t } = make({ content: "one" });
    expect(update(doc, t.id, { content: "one\ntwo" }).height).toBe(28.8);
    expect(update(doc, t.id, { content: "one" }).height).toBe(14.4);
    expect(update(doc, t.id, { fontSize: 24 })).toMatchObject({ height: 28.8, autoSize: true });
    // Two words that wrap at a narrower width.
    update(doc, t.id, { content: "one two", fontSize: 12 });
    expect(update(doc, t.id, { width: 30 })).toMatchObject({ height: 28.8, autoSize: true });
    const ranges = [{ start: 0, end: 3, fontSize: 16 }];
    const ranged = update(doc, t.id, { ranges });
    expect(ranged).toMatchObject({ height: pointHeight({ content: "one\ntwo", ranges }) });
    expect(ranged.height).toBeGreaterThan(28.8);
    expect(update(doc, t.id, { leading: 10 }).height).toBe(
      pointHeight({ content: "one\ntwo", leading: 10, ranges }),
    );
    expect(update(doc, t.id, { alignment: "center" })).toMatchObject({ autoSize: true });
  });

  it("turns off with height, frame, false or null; true fits a fixed frame", () => {
    const { doc, t } = make({ content: "one" });
    expect(update(doc, t.id, { height: 50 })).not.toHaveProperty("autoSize");
    expect(doc.nodes.get(t.id)).toMatchObject({ height: 50 });
    expect(update(doc, t.id, { autoSize: true })).toMatchObject({ autoSize: true, height: 14.4 });
    for (const off of [false, null]) {
      update(doc, t.id, { autoSize: true });
      const fixed = update(doc, t.id, { autoSize: off });
      expect(fixed).not.toHaveProperty("autoSize");
      expect(update(doc, t.id, { content: "one\ntwo" }).height).toBe(14.4);
      update(doc, t.id, { content: "one" });
    }
    update(doc, t.id, { autoSize: true });
    const shaped = update(doc, t.id, { frame: "M 0 0 L 90 0 L 45 60 Z" });
    expect(shaped).not.toHaveProperty("autoSize");
    expect(shaped).toMatchObject({ frame: "M 0 0 L 90 0 L 45 60 Z", height: 60 });
    expect(update(doc, t.id, { autoSize: false })).toEqual(shaped);
  });

  it("refuses each misuse at its key, writing nothing", () => {
    const { doc, t } = make({ content: "one" });
    const point = make({ kind: "point", width: undefined, autoSize: undefined }).t;
    const { doc: pdoc } = make({});
    pdoc.nodes.set(point.id, point);
    const before = doc.nodes.get(t.id);
    const refuse = (d: Document, id: string, patch: Record<string, unknown>, key: string) =>
      expect(errorOf(() => updateNodes(d, [{ nodeId: id, patch }]))).toMatchObject({
        code: "INVALID_PATCH",
        path: `updates[0].patch.${key}`,
      });
    refuse(doc, t.id, { autoSize: true, height: 30 }, "height");
    refuse(doc, t.id, { autoSize: true, frame: "M 0 0 L 90 0 L 45 60 Z" }, "autoSize");
    // Named before any value the per-type schema refuses.
    refuse(doc, t.id, { autoSize: true, frame: 5 }, "autoSize");
    refuse(
      doc,
      t.id,
      { autoSize: true, frame: "M 0 0 L 90 0 L 45 60 Z", fontSize: -1 },
      "autoSize",
    );
    refuse(doc, t.id, { autoSize: true, kind: "area" }, "autoSize");
    refuse(pdoc, point.id, { autoSize: true }, "autoSize");
    expect(doc.nodes.get(t.id)).toBe(before);
    update(doc, t.id, { frame: "M 0 0 L 90 0 L 45 60 Z" });
    refuse(doc, t.id, { autoSize: true }, "autoSize");
    refuse(doc, t.id, { autoSize: true, content: 5 }, "autoSize");
    // The input schema refuses the mixes at create: MCP answers them INVALID_INPUT.
    const issue = (extra: object) =>
      NodeInput.safeParse({
        type: "text",
        kind: "area",
        parentId: "l",
        x: 0,
        y: 0,
        width: 100,
        content: "x",
        autoSize: true,
        ...extra,
      }).error?.issues[0];
    expect(issue({})).toBeUndefined();
    expect(issue({ height: 30 })).toMatchObject({ path: ["height"] });
    expect(
      issue({ x: undefined, y: undefined, width: undefined, frame: "M 0 0 L 9 0 L 9 9 Z" }),
    ).toMatchObject({ path: ["autoSize"] });
    expect(issue({ x: undefined, y: undefined, width: undefined, frameNodeId: "s" })).toMatchObject(
      { path: ["autoSize"] },
    );
    expect(issue({ kind: "point", width: undefined })).toMatchObject({ path: ["autoSize"] });
    expect(issue({ autoSize: false })).toMatchObject({ path: ["height"] });
    expect(issue({ kind: "point", width: undefined, autoSize: false })).toMatchObject({
      path: ["autoSize"],
    });
  });

  it("converts: Area to Point drops the flag and Point to Area leaves it off", () => {
    const { doc, t } = make({ content: "one two" });
    const point = update(doc, t.id, { kind: "point" });
    expect(point).not.toHaveProperty("autoSize");
    expect(update(doc, t.id, { kind: "area" })).not.toHaveProperty("autoSize");
  });

  it("transform and duplicate keep the flag and height", () => {
    const { doc, t } = make({ content: "one\ntwo" });
    transformNodes(doc, { nodeIds: [t.id], scale: { x: 2, y: 3 } });
    const scaled = doc.nodes.get(t.id) as Text;
    expect(scaled).toMatchObject({ autoSize: true, height: 28.8, width: 100 });
    expect(scaled.transform).not.toEqual(t.transform);
    const [copy] = duplicateNodes(doc, { nodeIds: [t.id] }).created as [Text];
    expect(copy).toMatchObject({ autoSize: true, height: 28.8 });
  });

  it("still warns TEXT_OVERFLOW for a unit no height shows", () => {
    const { t } = make({ content: "a Pneumonoultramicroscopic word", width: 20 });
    expect(t.height).toBe(14.4);
    expect(overflowWarnings([t])).toMatchObject([{ code: "TEXT_OVERFLOW" }]);
  });

  it("refits a stale stored height on Open", () => {
    const { doc, t } = make({ content: "one\ntwo" });
    const file = JSON.parse(serializeDocument(doc));
    file.nodes.find((n: { id: string }) => n.id === t.id).height = 3;
    const read = parseDocument(JSON.stringify(file)).nodes.find((n) => n.id === t.id);
    expect(read).toEqual(t);
  });
});
