import { describe, expect, it } from "vitest";
import {
  bounds,
  childrenOf,
  clippingPath,
  createDocument,
  createNodes,
  ellipseMatrix,
  outline,
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
import { applyTo, compose, IDENTITY, invert } from "./matrix.ts";
import type { Document, Gradient, Node, ShapeNode } from "./schema.ts";

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
    [{ kind: "area" }, "kind", /kind is fixed/],
    [{ width: 10 }, "width", /leading/],
    [{ content: "a\tb" }, "content", /./],
    [{ d: "M 0 0" }, "d", /outline/i],
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
        /meta, x, y, content, fontFamily, fontStyle, fontSize, leading, tracking, ranges, appearance/,
      );
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
