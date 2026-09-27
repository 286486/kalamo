import { describe, expect, it } from "vitest";
import {
  assertParent,
  bounds,
  createDocument,
  createNodes,
  nodeView,
  type OutlineNode,
  outline,
  paintedLeaves,
  queryNodes,
  touches,
  visibleBounds,
} from "./document.ts";
import { transformNodes } from "./edit.ts";
import { ZibelError } from "./errors.ts";
import { makeMask } from "./mask.ts";
import { compose } from "./matrix.ts";
import { AppearanceInput, type Node, NodeQuery } from "./schema.ts";

const newDoc = () =>
  createDocument({ id: "d", name: "Doc", artboards: [{ width: 200, height: 100 }] });

const rect = (parentId: string) => ({
  type: "rect" as const,
  parentId,
  x: 10,
  y: 10,
  width: 50,
  height: 30,
});

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ZibelError) return e.data;
    throw e;
  }
  throw new Error("expected a ZibelError");
};

it("creates a Document whose outline starts with one default Layer", () => {
  const { doc, defaultLayerId } = newDoc();
  expect(doc.artboards).toMatchObject([{ frame: { x: 0, y: 0, width: 200, height: 100 } }]);
  expect(outline(doc)).toMatchObject([{ id: defaultLayerId, type: "layer", childCount: 0 }]);
});

it("puts a rect into the Layer and reports its bounds", () => {
  const { doc, defaultLayerId } = newDoc();
  const [node] = createNodes(doc, [rect(defaultLayerId)]).nodes;
  expect(outline(doc)).toMatchObject([
    {
      id: defaultLayerId,
      childCount: 1,
      bounds: { x: 10, y: 10, width: 50, height: 30 },
      children: [{ id: node?.id, type: "rect", bounds: { x: 10, y: 10, width: 50, height: 30 } }],
    },
  ]);
});

it("keeps siblings in creation order", () => {
  const { doc, defaultLayerId } = newDoc();
  const created = createNodes(doc, [
    rect(defaultLayerId),
    rect(defaultLayerId),
    rect(defaultLayerId),
  ]).nodes;
  createNodes(doc, [rect(defaultLayerId)]);
  const ids = outline(doc)[0]?.children?.map((c) => c.id);
  expect(ids?.slice(0, 3)).toEqual(created.map((n) => n.id));
  expect(ids).toHaveLength(4);
});

it("rejects a parent that is not a Layer or Group with INVALID_PARENT", () => {
  const { doc, defaultLayerId } = newDoc();
  const [r] = createNodes(doc, [rect(defaultLayerId)]).nodes;
  expect(codeOf(() => createNodes(doc, [rect(defaultLayerId), rect(r?.id ?? "")]))).toMatchObject({
    code: "INVALID_PARENT",
    path: "nodes[1].parentId",
  });
});

it("rejects an unknown parent with NODE_NOT_FOUND and creates nothing", () => {
  const { doc, defaultLayerId } = newDoc();
  expect(codeOf(() => createNodes(doc, [rect(defaultLayerId), rect("nope")]))).toMatchObject({
    code: "NODE_NOT_FOUND",
    path: "nodes[1].parentId",
  });
  expect(outline(doc)[0]?.childCount).toBe(0);
});

it("rejects an Artboard id as a parent", () => {
  const { doc } = newDoc();
  const artboardId = doc.artboards[0]?.id ?? "";
  expect(codeOf(() => createNodes(doc, [rect(artboardId)]))).toMatchObject({
    code: "INVALID_PARENT",
  });
});

it("stores an Appearance with its defaults filled in", () => {
  const { doc, defaultLayerId } = newDoc();
  const [node] = createNodes(doc, [
    {
      ...rect(defaultLayerId),
      appearance: {
        fills: [{ color: "#ff8800" }],
        strokes: [{ color: "#000000AA", width: 2, cap: "round", dash: [4, 2] }],
      },
    },
  ]).nodes;
  expect(node).toMatchObject({
    appearance: {
      fills: [{ type: "solid", color: "#ff8800" }],
      strokes: [
        { color: "#000000AA", width: 2, cap: "round", join: "miter", miterLimit: 10, dash: [4, 2] },
      ],
    },
  });
});

describe("gradients", () => {
  const last = { offset: 1, color: "#9FD0FF00" };
  const first = { offset: 0, color: "#1F5FBF" };
  const stops = [last, first];
  const linear = { type: "linear", stops, start: { x: 0, y: 5 }, end: { x: 20, y: 5 } } as const;
  const radial = {
    type: "radial",
    stops,
    center: { x: 30, y: 25 },
    radius: 20,
    aspectRatio: 0.5,
    angle: 30,
    focus: { x: 35, y: 25 },
  } as const;

  it("stores a gradient Fill and Stroke with sorted stops beside a solid Fill", () => {
    const { doc, defaultLayerId } = newDoc();
    const [node] = createNodes(doc, [
      {
        ...rect(defaultLayerId),
        appearance: {
          fills: [{ color: "#FF8800" }, { type: "gradient", gradient: linear }],
          strokes: [{ type: "gradient", gradient: radial, width: 2 }],
        },
      },
    ]).nodes;
    const sorted = [first, last];
    expect(node).toMatchObject({
      appearance: {
        fills: [
          { type: "solid", color: "#FF8800" },
          { type: "gradient", gradient: { ...linear, stops: sorted } },
        ],
        strokes: [{ type: "gradient", gradient: { ...radial, stops: sorted }, width: 2 }],
      },
    });
  });

  it("keeps equal offsets in the order given, for a hard edge", () => {
    const { doc, defaultLayerId } = newDoc();
    const edge = [
      { offset: 0.5, color: "#FF0000" },
      { offset: 0.5, color: "#0000FF" },
      { offset: 0, color: "#000000" },
    ];
    const [node] = createNodes(doc, [
      {
        ...rect(defaultLayerId),
        appearance: { fills: [{ type: "gradient", gradient: { ...linear, stops: edge } }] },
      },
    ]).nodes;
    expect(node).toMatchObject({
      appearance: { fills: [{ gradient: { stops: [edge[2], edge[0], edge[1]] } }] },
    });
  });

  it("answers a bad stop colour with INVALID_COLOR at its path", () => {
    const { doc, defaultLayerId } = newDoc();
    const bad = [last, { offset: 0, color: "red" }];
    expect(
      codeOf(() =>
        createNodes(doc, [
          {
            ...rect(defaultLayerId),
            appearance: { fills: [{ type: "gradient", gradient: { ...linear, stops: bad } }] },
          },
        ]),
      ),
    ).toMatchObject({
      code: "INVALID_COLOR",
      path: "nodes[0].appearance.fills[0].gradient.stops[1].color",
    });
  });

  it.each([
    ["one stop", { ...linear, stops: [last] }, "stops"],
    [
      "an offset above 1",
      { ...linear, stops: [last, { offset: 1.5, color: "#000000" }] },
      "stops.1.offset",
    ],
    ["start without end", { type: "linear", stops, start: { x: 0, y: 0 } }, "end"],
    ["start equal to end", { ...linear, end: linear.start }, "end"],
    ["a radius of 0", { ...radial, radius: 0 }, "radius"],
    ["an aspect ratio of 0", { ...radial, aspectRatio: 0 }, "aspectRatio"],
  ])("refuses %s with the field's path", (_, gradient, path) => {
    const parsed = AppearanceInput.safeParse({ fills: [{ type: "gradient", gradient }] });
    expect(parsed.error?.issues[0]?.path.join(".")).toBe(`fills.0.gradient.${path}`);
  });

  describe("geometry left out comes from the leaf's own bounds", () => {
    const fillOf = (input: Record<string, unknown>, gradient: Record<string, unknown>) => {
      const { doc, defaultLayerId } = newDoc();
      const [node] = createNodes(doc, [
        {
          type: "rect",
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          ...input,
          parentId: defaultLayerId,
          appearance: { fills: [{ type: "gradient", gradient: { stops, ...gradient } }] },
        } as never,
      ]).nodes;
      if (!node || node.type !== "rect") throw new Error("setup");
      const [fill] = node.appearance.fills;
      if (fill?.type !== "gradient") throw new Error("setup");
      return fill.gradient;
    };

    it.each([
      [undefined, { x: 10, y: 45 }, { x: 110, y: 45 }],
      [90, { x: 60, y: 20 }, { x: 60, y: 70 }],
      [180, { x: 110, y: 45 }, { x: 10, y: 45 }],
      // Along the diagonal the box projects to (100 + 50) / sqrt(2).
      [45, { x: 22.5, y: 7.5 }, { x: 97.5, y: 82.5 }],
    ])("spans the bounds at angle %j, and does not store the angle", (angle, start, end) => {
      const g = fillOf({}, { type: "linear", angle });
      expect(g).toEqual({ type: "linear", stops: [first, last], start, end });
    });

    it("gives a radial gradient Illustrator's centre and radius", () => {
      expect(fillOf({}, { type: "radial" })).toEqual({
        type: "radial",
        stops: [first, last],
        center: { x: 60, y: 45 },
        radius: 39.528,
        aspectRatio: 1,
        angle: 0,
        focus: { x: 60, y: 45 },
      });
    });

    it("makes a vector 1 pt long where the bounds have no extent", () => {
      const g = fillOf({ height: 0 }, { type: "linear", angle: 90 });
      expect(g).toMatchObject({ start: { x: 60, y: 19.5 }, end: { x: 60, y: 20.5 } });
      expect(fillOf({ width: 0, height: 0 }, { type: "radial" })).toMatchObject({ radius: 1 });
    });

    it("moves a focus outside the ellipse onto it", () => {
      const g = fillOf(
        {},
        { type: "radial", radius: 10, aspectRatio: 2, angle: 90, focus: { x: 160, y: 45 } },
      );
      // Across angle 90 is horizontal, where the radius is 10 × 2.
      expect(g).toMatchObject({ focus: { x: 80, y: 45 } });
    });

    it("takes a text's bounds from its box", () => {
      const { doc, defaultLayerId } = newDoc();
      const [node] = createNodes(doc, [
        {
          type: "text",
          kind: "area",
          parentId: defaultLayerId,
          x: 0,
          y: 0,
          width: 40,
          height: 20,
          content: "Hi",
          appearance: { fills: [{ type: "gradient", gradient: { type: "linear", stops } }] },
        },
      ]).nodes;
      expect(node).toMatchObject({
        appearance: { fills: [{ gradient: { start: { x: 0, y: 10 }, end: { x: 40, y: 10 } } }] },
      });
    });
  });
});

it("gives a shape without an Appearance Illustrator's default: white Fill, 1 pt black Stroke", () => {
  const { doc, defaultLayerId } = newDoc();
  const [plain, bare] = createNodes(doc, [
    rect(defaultLayerId),
    { ...rect(defaultLayerId), appearance: {} },
  ]).nodes;
  expect(plain).toMatchObject({
    appearance: { fills: [{ color: "#FFFFFF" }], strokes: [{ color: "#000000", width: 1 }] },
  });
  expect(bare).toMatchObject({ appearance: { fills: [], strokes: [] } });
});

it.each([
  ["rgb(255, 136, 0)", /#FF8800/],
  ["red", /#FF0000/],
  [[1, 0.5, 0], /#FF8000/],
  [0.5, /#RRGGBB/],
  ["#F80", /#FF8800/],
])("rejects the color %j with INVALID_COLOR and a conversion hint", (color, hint) => {
  const { doc, defaultLayerId } = newDoc();
  const error = codeOf(() =>
    createNodes(doc, [
      rect(defaultLayerId),
      { ...rect(defaultLayerId), appearance: { strokes: [{ color: "#000000" }, { color }] } },
    ]),
  );
  expect(error).toMatchObject({
    code: "INVALID_COLOR",
    path: "nodes[1].appearance.strokes[1].color",
  });
  expect(error.hint).toMatch(hint);
  expect(outline(doc)[0]?.childCount).toBe(0);
});

it("rejects a bad Artboard background with INVALID_COLOR", () => {
  expect(
    codeOf(() =>
      createDocument({
        id: "d",
        name: "Doc",
        artboards: [{ width: 1, height: 1, background: "white" }],
      }),
    ),
  ).toMatchObject({
    code: "INVALID_COLOR",
    path: "artboards[0].background",
    hint: expect.stringMatching(/#FFFFFF/),
  });
});

it("creates every leaf type and nested Layers, with bounds from their geometry", () => {
  const { doc, defaultLayerId: layer } = newDoc();
  const { nodes } = createNodes(doc, [
    { type: "layer", name: "Top" },
    { type: "layer", parentId: layer, name: "Sub" },
    { type: "ellipse", parentId: layer, x: 0, y: 0, width: 20, height: 10 },
    { type: "line", parentId: layer, x1: 5, y1: 50, x2: 25, y2: 40 },
    { type: "polygon", parentId: layer, cx: 50, cy: 50, radius: 10, sides: 6 },
    { type: "star", parentId: layer, cx: 0, cy: 0, outerRadius: 10, innerRadius: 3, points: 4 },
    { type: "path", parentId: layer, d: "M 0 0 L 10.00004 0 L 10 10 Z" },
  ]);
  expect(nodes.map((n) => [n.type, n.parentId])).toEqual([
    ["layer", null],
    ["layer", layer],
    ["ellipse", layer],
    ["line", layer],
    ["polygon", layer],
    ["star", layer],
    ["path", layer],
  ]);
  expect(nodes[6]).toMatchObject({ d: "M 0 0 L 10 0 L 10 10 Z" });
  const [top, main] = outline(doc);
  expect(top).toMatchObject({ name: "Layer 1", childCount: 6 });
  expect(main).toMatchObject({ name: "Top", childCount: 0, bounds: null });
  const box = Object.fromEntries((top?.children ?? []).map((c) => [c.type, c.bounds]));
  expect(box.ellipse).toEqual({ x: 0, y: 0, width: 20, height: 10 });
  expect(box.line).toEqual({ x: 5, y: 40, width: 20, height: 10 });
  expect(box.star).toEqual({ x: -10, y: -10, width: 20, height: 20 });
  expect(box.path).toEqual({ x: 0, y: 0, width: 10, height: 10 });
});

it("keeps a star's and a polygon's Inkscape parameters, 0 when omitted (ADR-0024)", () => {
  const { doc, defaultLayerId: layer } = newDoc();
  const star = {
    type: "star" as const,
    parentId: layer,
    cx: 0,
    cy: 0,
    outerRadius: 10,
    innerRadius: 3,
  };
  const { nodes } = createNodes(doc, [
    { ...star, points: 5, angle: 30, twist: 10, rounded: 0.3, randomized: 0.1 },
    { type: "polygon", parentId: layer, cx: 50, cy: 50, radius: 10, sides: 6 },
  ]);
  expect(nodes[0]).toMatchObject({ angle: 30, twist: 10, rounded: 0.3, randomized: 0.1 });
  expect(nodes[1]).toMatchObject({ angle: 0, rounded: 0, randomized: 0 });
  expect(nodes[1]).not.toHaveProperty("twist");
  expect(() => createNodes(doc, [{ ...star, points: 5, rounded: 11 } as never])).toThrow(/rounded/);
});

it("keeps an ellipse's angles and arc type, the whole slice when omitted (ADR-0025)", () => {
  const { doc, defaultLayerId: layer } = newDoc();
  const ellipse = { type: "ellipse" as const, parentId: layer, x: 0, y: 0, width: 20, height: 10 };
  const { nodes } = createNodes(doc, [
    { ...ellipse, startAngle: 300, endAngle: 60, arcType: "chord" },
    ellipse,
  ]);
  expect(nodes[0]).toMatchObject({ startAngle: 300, endAngle: 60, arcType: "chord" });
  expect(nodes[1]).toMatchObject({ startAngle: 0, endAngle: 360, arcType: "slice" });
  for (const [key, value] of [
    ["startAngle", 360],
    ["endAngle", 0],
    ["arcType", "pie"],
  ] as const) {
    expect(() => createNodes(doc, [{ ...ellipse, [key]: value } as never])).toThrow(key);
  }
});

it("returns INVALID_PATH at the item's d", () => {
  const { doc, defaultLayerId } = newDoc();
  expect(
    codeOf(() => createNodes(doc, [{ type: "path", parentId: defaultLayerId, d: "M 0 0 h 10" }])),
  ).toMatchObject({ code: "INVALID_PATH", path: "nodes[0].d", hint: expect.any(String) });
});

it("creates a Group with inline children, depth first, with a keyMap for every clientKey", () => {
  const { doc, defaultLayerId } = newDoc();
  const { nodes, keyMap } = createNodes(doc, [
    {
      type: "group",
      parentId: defaultLayerId,
      clientKey: "g",
      children: [
        { ...rect(defaultLayerId), clientKey: "a" },
        {
          type: "group",
          clientKey: "inner",
          children: [{ type: "line", clientKey: "b", x1: 0, y1: 0, x2: 100, y2: 80 }],
        },
      ],
    },
    { ...rect(defaultLayerId), clientKey: "c" },
  ]);
  const [g, a, inner, b, c] = nodes;
  expect(nodes.map((n) => n.type)).toEqual(["group", "rect", "group", "line", "rect"]);
  expect([a?.parentId, inner?.parentId, b?.parentId, c?.parentId]).toEqual([
    g?.id,
    g?.id,
    inner?.id,
    defaultLayerId,
  ]);
  expect(keyMap).toEqual({ g: g?.id, a: a?.id, inner: inner?.id, b: b?.id, c: c?.id });
  expect(outline(doc, { depth: 3 })[0]?.children?.[0]).toMatchObject({
    type: "group",
    childCount: 2,
    bounds: { x: 0, y: 0, width: 100, height: 80 },
  });
});

describe("tree rules (ADR-0005)", () => {
  const setup = () => {
    const { doc, defaultLayerId: layer } = newDoc();
    const [group, inner, leaf] = createNodes(doc, [
      {
        type: "group",
        parentId: layer,
        children: [{ type: "group", children: [rect(layer)] }],
      },
    ]).nodes;
    const [sub] = createNodes(doc, [{ type: "layer", parentId: layer }]).nodes;
    const id = (n: { id: string } | undefined) => n?.id ?? "";
    return { doc, layer, group: id(group), inner: id(inner), leaf: id(leaf), sub: id(sub) };
  };
  const t = setup();
  const artboard = t.doc.artboards[0]?.id ?? "";

  it.each([
    // [child type, parent, allowed]
    ["layer", null, true],
    ["layer", t.layer, true],
    ["layer", t.sub, true],
    ["layer", t.group, false],
    ["layer", t.leaf, false],
    ["group", null, false],
    ["group", t.layer, true],
    ["group", t.group, true],
    ["group", t.leaf, false],
    ["rect", null, false],
    ["rect", t.layer, true],
    ["rect", t.inner, true],
    ["rect", t.leaf, false],
    ["rect", artboard, false],
  ] as const)("a %s under %s: %s", (type, parentId, allowed) => {
    const check = () => assertParent(t.doc, { type }, parentId, "p");
    if (allowed) expect(check).not.toThrow();
    else
      expect(codeOf(check)).toMatchObject({
        code: "INVALID_PARENT",
        path: "p",
        hint: expect.any(String),
      });
  });

  it("rejects an unknown parent with NODE_NOT_FOUND", () => {
    expect(codeOf(() => assertParent(t.doc, { type: "rect" }, "nope", "p"))).toMatchObject({
      code: "NODE_NOT_FOUND",
    });
  });

  it("rejects a cycle: a Group under itself or its own descendant", () => {
    for (const parentId of [t.group, t.inner]) {
      expect(
        codeOf(() => assertParent(t.doc, { type: "group", id: t.group }, parentId, "p")),
      ).toMatchObject({ code: "INVALID_PARENT", message: expect.stringMatching(/cycle/) });
    }
    expect(() => assertParent(t.doc, { type: "group", id: t.inner }, t.layer, "p")).not.toThrow();
  });

  it("rejects a parent inside a cycle that does not include the child, as a file can carry", () => {
    const { doc } = newDoc();
    const [a, b] = createNodes(doc, [
      { type: "group", parentId: [...doc.nodes.keys()][0] ?? "" },
      { type: "group", parentId: [...doc.nodes.keys()][0] ?? "" },
    ]).nodes;
    if (!a || !b) throw new Error("expected two Groups");
    a.parentId = b.id;
    b.parentId = a.id;
    expect(codeOf(() => assertParent(doc, { type: "rect", id: "c" }, a.id, "p"))).toMatchObject({
      code: "INVALID_PARENT",
      message: expect.stringMatching(/cycle/),
    });
  });

  it("rejects a Layer under a Group through node_create too, creating nothing", () => {
    const before = t.doc.nodes.size;
    expect(
      codeOf(() => createNodes(t.doc, [rect(t.layer), { type: "layer", parentId: t.group }])),
    ).toMatchObject({ code: "INVALID_PARENT", path: "nodes[1].parentId" });
    expect(t.doc.nodes.size).toBe(before);
  });
});

describe("nodeView", () => {
  const setup = () => {
    const { doc, defaultLayerId } = newDoc();
    const [group, round, path] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        name: "G",
        children: [
          {
            type: "rect",
            x: 0,
            y: 0,
            width: 40,
            height: 20,
            radius: 5,
            appearance: {
              strokes: [
                { color: "#000000", width: 2 },
                { color: "#FF0000", width: 6 },
              ],
            },
          },
          { type: "path", d: "M 0 0 L 10 0 L 10 10", fillRule: "evenodd" },
        ],
      },
    ]).nodes;
    if (!group || !round || !path) throw new Error("setup");
    return { doc, group, round, path };
  };

  it("full: parameters, derived d, Appearance, bounds and worldTransform", () => {
    const { doc, round } = setup();
    const view = nodeView(doc, round, "full");
    expect(view).toMatchObject({
      id: round.id,
      type: "rect",
      x: 0,
      y: 0,
      width: 40,
      height: 20,
      radius: 5,
      appearance: { fills: [], strokes: [{ width: 2 }, { width: 6 }] },
      geometricBounds: { x: 0, y: 0, width: 40, height: 20 },
      visibleBounds: { x: -3, y: -3, width: 46, height: 26 },
      worldTransform: [1, 0, 0, 1, 0, 0],
      childCount: 0,
    });
    expect(view.d).toMatch(/^M 5 0 L 35 0 C/);
    expect(view.closed).toBe(true);
  });

  it("full: a Path returns its stored d", () => {
    const { doc, path } = setup();
    expect(nodeView(doc, path, "full")).toMatchObject({
      d: "M 0 0 L 10 0 L 10 10",
      closed: false,
      fillRule: "evenodd",
    });
  });

  it("concise: identity, structure and geometric bounds only", () => {
    const { doc, group, round } = setup();
    const view = nodeView(doc, round, "concise");
    expect(view).toEqual({
      id: round.id,
      type: "rect",
      name: "",
      parentId: group.id,
      visible: true,
      locked: false,
      childCount: 0,
      geometricBounds: { x: 0, y: 0, width: 40, height: 20 },
    });
    expect(nodeView(doc, group, "concise")).toMatchObject({ childCount: 2 });
  });

  it("worldTransform composes the ancestors' transforms", () => {
    const { doc, group, round } = setup();
    group.transform = [2, 0, 0, 2, 10, 20];
    round.transform = [1, 0, 0, 1, 5, 5];
    expect(nodeView(doc, round, "full").worldTransform).toEqual([2, 0, 0, 2, 20, 30]);
  });

  it("a container's visibleBounds covers its children's Strokes", () => {
    const { doc, group } = setup();
    expect(nodeView(doc, group, "full")).toMatchObject({
      geometricBounds: { x: 0, y: 0, width: 40, height: 20 },
      visibleBounds: { x: -3, y: -3, width: 46, height: 26 },
    });
  });
});

it("rejects an inline Layer in a Group's children with INVALID_PARENT, creating nothing", () => {
  const { doc, defaultLayerId } = newDoc();
  const before = doc.nodes.size;
  expect(
    codeOf(() =>
      createNodes(doc, [
        {
          type: "group",
          parentId: defaultLayerId,
          children: [rect(defaultLayerId), { type: "layer" }],
        },
      ]),
    ),
  ).toMatchObject({
    code: "INVALID_PARENT",
    path: "nodes[0].children[1].type",
    hint: expect.any(String),
  });
  expect(doc.nodes.size).toBe(before);
});

it("gives each default Appearance its own arrays", () => {
  const { doc, defaultLayerId } = newDoc();
  const [a, b] = createNodes(doc, [rect(defaultLayerId), rect(defaultLayerId)]).nodes;
  if (!a || !b || a.type !== "rect" || b.type !== "rect") throw new Error("setup");
  expect(a.appearance.strokes[0]?.dash).not.toBe(b.appearance.strokes[0]?.dash);
});

describe("bounds honour transform", () => {
  it("rotates a rect's bounds about its center", () => {
    const { doc, defaultLayerId } = newDoc();
    const [node] = createNodes(doc, [rect(defaultLayerId)]).nodes;
    if (!node) throw new Error("setup");
    node.transform = compose({ rotate: 90 }, { x: 35, y: 25 });
    const b = bounds(doc, node);
    expect(b?.x).toBeCloseTo(20, 9);
    expect(b?.y).toBeCloseTo(0, 9);
    expect(b?.width).toBeCloseTo(30, 9);
    expect(b?.height).toBeCloseTo(50, 9);
  });

  it("finds the true extent of a rotated ellipse, not its control points", () => {
    const { doc, defaultLayerId } = newDoc();
    const [e] = createNodes(doc, [
      { type: "ellipse", parentId: defaultLayerId, x: 0, y: 0, width: 100, height: 50 },
    ]).nodes;
    if (!e) throw new Error("setup");
    e.transform = compose({ rotate: 45 }, { x: 50, y: 25 });
    const c = Math.SQRT1_2;
    expect(bounds(doc, e)?.width).toBeCloseTo(
      2 * Math.sqrt(50 ** 2 * c ** 2 + 25 ** 2 * c ** 2),
      1,
    );
  });

  it("applies the ancestors' transforms and scales the Stroke growth", () => {
    const { doc, defaultLayerId } = newDoc();
    const [g, r] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        children: [
          { ...rect(defaultLayerId), appearance: { strokes: [{ color: "#000000", width: 2 }] } },
        ],
      },
    ]).nodes;
    if (!g || !r) throw new Error("setup");
    g.transform = [2, 0, 0, 2, 10, 20];
    expect(bounds(doc, r)).toEqual({ x: 30, y: 40, width: 100, height: 60 });
    expect(visibleBounds(doc, r)).toEqual({ x: 28, y: 38, width: 104, height: 64 });
    expect(outline(doc)[0]?.bounds).toEqual({ x: 30, y: 40, width: 100, height: 60 });
  });
});

it("stores tags and meta given at creation", () => {
  const { doc, defaultLayerId } = newDoc();
  const [r] = createNodes(doc, [{ ...rect(defaultLayerId), tags: ["bar"], meta: { q: 3 } }]).nodes;
  expect(r).toMatchObject({ tags: ["bar"], meta: { q: 3 } });
});

describe("the 2000-Node cap per node_create", () => {
  it("counts inline children and hints how to split", () => {
    const { doc, defaultLayerId } = newDoc();
    const flat = Array.from({ length: 2001 }, () => rect(defaultLayerId));
    const nested = [
      {
        type: "group" as const,
        parentId: defaultLayerId,
        children: Array.from({ length: 2000 }, () => ({
          ...rect(defaultLayerId),
          parentId: undefined,
        })),
      },
    ];
    for (const inputs of [flat, nested]) {
      expect(codeOf(() => createNodes(doc, inputs))).toMatchObject({
        code: "LIMIT_EXCEEDED",
        path: "nodes",
        hint: expect.stringMatching(/2000.*[Ss]plit|[Ss]plit.*2000/),
      });
    }
    expect(doc.nodes.size).toBe(1);
    expect(createNodes(doc, flat.slice(1)).nodes).toHaveLength(2000);
  });
});

it("creates the valid items with partial and reports the invalid one", () => {
  const { doc, defaultLayerId } = newDoc();
  const { nodes, failed, keyMap } = createNodes(
    doc,
    [
      { ...rect(defaultLayerId), clientKey: "a" },
      {
        type: "group",
        parentId: defaultLayerId,
        clientKey: "g",
        children: [rect(defaultLayerId), { type: "layer" }],
      },
    ],
    { partial: true },
  );
  expect(nodes).toHaveLength(1);
  expect(Object.keys(keyMap)).toEqual(["a"]);
  expect(failed).toMatchObject([
    { index: 1, code: "INVALID_PARENT", path: "nodes[1].children[1].type" },
  ]);
  expect(outline(doc)[0]?.childCount).toBe(1);
});

describe("text", () => {
  // Advances from the TTF at 12 pt: H 652, i 246, space 200; ascender 1000, descender -326.
  const text = (parentId: string, content = "Hi") =>
    ({ type: "text", parentId, x: 10, y: 50, content }) as const;

  it("stores Point Type in Source Sans 3 at 12 pt with a black Fill and no Stroke", () => {
    const { doc, defaultLayerId } = newDoc();
    const [node] = createNodes(doc, [text(defaultLayerId)]).nodes;
    expect(node).toMatchObject({
      type: "text",
      kind: "point",
      x: 10,
      y: 50,
      content: "Hi",
      fontFamily: "Source Sans 3",
      fontStyle: "Regular",
      fontSize: 12,
      appearance: { fills: [{ color: "#000000" }], strokes: [] },
    });
  });

  it("refuses a style name outside ADR-0028's, listing them", () => {
    const { doc, defaultLayerId } = newDoc();
    expect(() =>
      createNodes(doc, [{ ...text(defaultLayerId), fontStyle: "Heavy" } as never]),
    ).toThrow(/Black Italic/);
  });

  it("is bounded by its advances and the font's ascender and descender, and has no d", () => {
    const { doc, defaultLayerId } = newDoc();
    const [hi, longer] = createNodes(doc, [
      text(defaultLayerId),
      text(defaultLayerId, "Hi Hi"),
    ]).nodes;
    if (!hi || !longer) throw new Error("setup");
    const b = bounds(doc, hi);
    expect(b?.x).toBeCloseTo(10);
    expect(b?.y).toBeCloseTo(38);
    expect(b?.width).toBeCloseTo(10.776);
    expect(b?.height).toBeCloseTo(15.912);
    expect((bounds(doc, longer)?.width ?? 0) - (b?.width ?? 0)).toBeCloseTo(13.176);
    const full = nodeView(doc, hi, "full");
    expect(full).not.toHaveProperty("d");
    expect(full).not.toHaveProperty("closed");
  });

  it("maps its box through its transform", () => {
    const { doc, defaultLayerId } = newDoc();
    const [node] = createNodes(doc, [text(defaultLayerId)]).nodes;
    if (!node) throw new Error("setup");
    doc.nodes.set(node.id, { ...node, transform: [0, 1, -1, 0, 0, 0] });
    const b = bounds(doc, doc.nodes.get(node.id) ?? node);
    // (10, 38)-(20.776, 53.912) turned 90° clockwise about the origin.
    expect(b?.x).toBeCloseTo(-53.912);
    expect(b?.y).toBeCloseTo(10);
    expect(b?.width).toBeCloseTo(15.912);
    expect(b?.height).toBeCloseTo(10.776);
  });

  it("is created inline in a Group", () => {
    const { doc, defaultLayerId } = newDoc();
    const [group, inner] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        children: [{ type: "text", x: 10, y: 50, content: "Hi" }],
      },
    ]).nodes;
    expect(inner).toMatchObject({ type: "text", parentId: group?.id });
  });

  it.each(["", "a\rb", "a\tb", "a\u2028b"])("rejects content %j", (content) => {
    const { doc, defaultLayerId } = newDoc();
    expect(() => createNodes(doc, [text(defaultLayerId, content)])).toThrow();
    expect(doc.nodes.size).toBe(1);
  });

  it("keeps hard returns, and a set leading", () => {
    const { doc, defaultLayerId } = newDoc();
    const [node] = createNodes(doc, [{ ...text(defaultLayerId, "a\nb"), leading: 15 }]).nodes;
    expect(node).toMatchObject({ content: "a\nb", leading: 15 });
  });

  it("stores Area Type with its frame, which is its bounds", () => {
    const { doc, defaultLayerId } = newDoc();
    const frame = { x: 10, y: 20, width: 100, height: 40 };
    const [node] = createNodes(doc, [
      { type: "text", kind: "area", parentId: defaultLayerId, ...frame, content: "Hi" },
    ]).nodes;
    expect(node).toMatchObject({ kind: "area", ...frame });
    expect(node && bounds(doc, node)).toEqual(frame);
  });

  it.each([
    [{ kind: "area", width: 100 }, /Area Type needs width and height/],
    [{ width: 100 }, /set kind to area/],
  ])("refuses a frame that does not match the kind: %j", (extra, message) => {
    const { doc, defaultLayerId } = newDoc();
    const input = { ...text(defaultLayerId), ...extra } as Parameters<
      typeof createNodes
    >[1][number];
    expect(() => createNodes(doc, [input])).toThrow(message);
    expect(doc.nodes.size).toBe(1);
  });

  describe("tracking and Character Ranges (ADR-0029)", () => {
    const create = (extra: object, content = "Hello") => {
      const { doc, defaultLayerId } = newDoc();
      return createNodes(doc, [{ ...text(defaultLayerId, content), ...extra } as never]).nodes[0];
    };

    it("stores ranges canonical: later wins per attribute, 0 clears, sorted and split", () => {
      const node = create({
        ranges: [
          { start: 0, end: 3, fill: "#FF0000" },
          { start: 2, end: 5, fill: "#0000FF", rotation: 10 },
          { start: 4, end: 5, rotation: 0 },
        ],
      });
      expect(node).toHaveProperty("ranges", [
        { start: 0, end: 2, fill: "#FF0000" },
        { start: 2, end: 4, fill: "#0000FF", rotation: 10 },
        { start: 4, end: 5, fill: "#0000FF" },
      ]);
    });

    it("merges adjacent ranges with the same overrides, and drops ones with none", () => {
      expect(
        create({
          ranges: [
            { start: 0, end: 1, fill: "#F00000" },
            { start: 1, end: 2, fill: "#F00000" },
          ],
        }),
      ).toHaveProperty("ranges", [{ start: 0, end: 2, fill: "#F00000" }]);
      expect(create({ ranges: [{ start: 0, end: 2, baselineShift: 0 }] })).not.toHaveProperty(
        "ranges",
      );
    });

    it("counts code points, not UTF-16 units", () => {
      expect(create({ ranges: [{ start: 2, end: 3, rotation: 5 }] }, "a😀b")).toHaveProperty(
        "ranges",
        [{ start: 2, end: 3, rotation: 5 }],
      );
      expect(() => create({ ranges: [{ start: 3, end: 4, rotation: 5 }] }, "a😀b")).toThrow();
    });

    it.each([
      { ranges: [{ start: 0, end: 6, rotation: 5 }] },
      { ranges: [{ start: 2, end: 2, rotation: 5 }] },
      { ranges: [{ start: 0, end: 1, rotation: 361 }] },
      { tracking: 10_001 },
    ])("refuses %j", (extra) => {
      expect(() => create(extra)).toThrow();
    });

    it("answers a bad range colour with INVALID_COLOR and a hint", () => {
      expect(codeOf(() => create({ ranges: [{ start: 0, end: 1, fill: "red" }] }))).toMatchObject({
        code: "INVALID_COLOR",
        path: "nodes[0].ranges[0].fill",
        hint: expect.stringContaining("#FF0000"),
      });
    });

    it("refuses ranges that cover more than 100 000 characters in all", () => {
      const ranges = Array.from({ length: 11 }, () => ({ start: 0, end: 10_000, rotation: 5 }));
      expect(() => create({ ranges }, "x".repeat(10_000))).toThrow(/100000|100 000/);
    });

    it("spans a default gradient over the bounds its ranges give", () => {
      const { doc, defaultLayerId } = newDoc();
      const [node] = createNodes(doc, [
        {
          ...text(defaultLayerId, "H"),
          ranges: [{ start: 0, end: 1, baselineShift: 20 }],
          appearance: {
            fills: [
              {
                type: "gradient",
                gradient: {
                  type: "linear",
                  stops: [
                    { offset: 0, color: "#000000" },
                    { offset: 1, color: "#FFFFFF" },
                  ],
                },
              },
            ],
          },
        } as never,
      ]).nodes;
      const b = bounds(doc, node as Node);
      const [fill] = (node as Extract<Node, { type: "text" }>).appearance.fills;
      if (!b || fill?.type !== "gradient" || fill.gradient.type !== "linear")
        throw new Error("setup");
      expect(fill.gradient.start.y).toBeCloseTo(b.y + b.height / 2);
    });

    it("stores tracking as given", () => {
      expect(create({ tracking: -50 })).toMatchObject({ tracking: -50 });
    });
  });
});

it("touches two rects that share only an edge, not two apart", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  expect(touches(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(true);
  expect(touches(a, { x: 10.5, y: 0, width: 5, height: 5 })).toBe(false);
});

describe("queryNodes", () => {
  /** Layer L: rect "Sun" (tagged sky, warm) at 0,0 10x10; Group G with rect "Moon" (sky) at 50,50
   * 10x10 and a hidden, locked text; an empty Group E. Layer M: nothing. */
  const fixture = () => {
    const { doc, defaultLayerId: L } = newDoc();
    const r = (name: string, x: number, tags: string[]) => ({
      type: "rect" as const,
      name,
      x,
      y: x,
      width: 10,
      height: 10,
      tags,
      clientKey: name,
    });
    const { keyMap } = createNodes(doc, [
      { ...r("Sun", 0, ["sky", "warm"]), parentId: L },
      {
        type: "group",
        parentId: L,
        name: "G",
        clientKey: "G",
        children: [
          r("Moon", 50, ["sky"]),
          { type: "text", x: 50, y: 100, content: "Hi", clientKey: "T" },
        ],
      },
      { type: "group", parentId: L, name: "E", clientKey: "E", children: [] },
      { type: "layer", name: "M", clientKey: "M" },
    ]);
    const ids = { L, ...keyMap } as Record<string, string>;
    const t = doc.nodes.get(ids.T as string);
    if (t) Object.assign(t, { visible: false, locked: true });
    return { doc, ids };
  };
  const names = (q: NodeQuery) => {
    const { doc } = fixture();
    return queryNodes(doc, q)
      .nodes.map((n) => n.name || n.type)
      .sort();
  };

  it("returns every Node without filters, hidden and locked ones included", () => {
    expect(names({})).toEqual(["E", "G", "Layer 1", "M", "Moon", "Sun", "text"]);
  });
  it("filters by types", () => {
    expect(names({ types: ["rect", "text"] })).toEqual(["Moon", "Sun", "text"]);
  });
  it("filters by nameRegex against the stored name", () => {
    expect(names({ nameRegex: "^(S|M)" })).toEqual(["M", "Moon", "Sun"]);
  });
  it("filters by tags, each Node carrying every listed tag", () => {
    expect(names({ tags: ["sky"] })).toEqual(["Moon", "Sun"]);
    expect(names({ tags: ["sky", "warm"] })).toEqual(["Sun"]);
  });
  it("filters by direct parent only; an unknown parent matches nothing", () => {
    const { doc, ids } = fixture();
    const of = (parentId: string) => queryNodes(doc, { parentId }).nodes.map((n) => n.name);
    expect(of(ids.L as string).sort()).toEqual(["E", "G", "Sun"]);
    expect(of("01NOPE")).toEqual([]);
  });
  it("filters by withinRect, edges included; an empty Group never matches", () => {
    expect(names({ withinRect: { x: 0, y: 0, width: 10, height: 10 } })).toEqual(["Sun"]);
    expect(names({ withinRect: { x: -1, y: -1, width: 1000, height: 1000 } })).toEqual([
      "G",
      "Layer 1",
      "Moon",
      "Sun",
      "text",
    ]);
  });
  it("filters by intersectsRect, touching counts", () => {
    expect(names({ intersectsRect: { x: 10, y: 10, width: 5, height: 5 } })).toEqual([
      "Layer 1",
      "Sun",
    ]);
  });
  it("ANDs the filters", () => {
    expect(names({ types: ["rect"], tags: ["sky"], nameRegex: "o" })).toEqual(["Moon"]);
  });

  it("pages through the matches in id order with nextCursor", () => {
    const { doc, defaultLayerId } = newDoc();
    const made = createNodes(
      doc,
      Array.from({ length: 5 }, () => rect(defaultLayerId)),
    ).nodes;
    const sorted = made.map((n) => n.id).sort();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const res = queryNodes(doc, { types: ["rect"], limit: 2, cursor });
      seen.push(...res.nodes.map((n) => n.id));
      cursor = res.nextCursor ?? undefined;
      expect(res.nextCursor === null).toBe(page === 2);
    }
    expect(seen).toEqual(sorted);
  });
  it("ends with nextCursor null when the last page is exactly full", () => {
    const { doc, defaultLayerId } = newDoc();
    createNodes(
      doc,
      Array.from({ length: 4 }, () => rect(defaultLayerId)),
    );
    const first = queryNodes(doc, { types: ["rect"], limit: 2 });
    const second = queryNodes(doc, { types: ["rect"], limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.nodes).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });
  it("returns concise views, 100 by default", () => {
    const { doc, defaultLayerId } = newDoc();
    createNodes(
      doc,
      Array.from({ length: 101 }, () => rect(defaultLayerId)),
    );
    const res = queryNodes(doc, { types: ["rect"] });
    expect(res.nodes).toHaveLength(100);
    expect(Object.keys(res.nodes[0] ?? {}).sort()).toEqual([
      "childCount",
      "geometricBounds",
      "id",
      "locked",
      "name",
      "parentId",
      "type",
      "visible",
    ]);
  });
  it("rejects a nameRegex that does not compile or runs past 200 characters", () => {
    expect(NodeQuery.safeParse({ nameRegex: "(" }).success).toBe(false);
    expect(NodeQuery.safeParse({ nameRegex: "a".repeat(201) }).success).toBe(false);
    expect(NodeQuery.safeParse({ nameRegex: "a".repeat(200) }).success).toBe(true);
  });
});

describe("outline options", () => {
  /** Layer 1: rect, Group G (rect, Group H (text)); Layer 2: empty. */
  const fixture = () => {
    const { doc, defaultLayerId: L } = newDoc();
    const { keyMap } = createNodes(doc, [
      rect(L),
      {
        type: "group",
        parentId: L,
        clientKey: "G",
        children: [
          { type: "rect", x: 0, y: 0, width: 5, height: 5, clientKey: "R" },
          {
            type: "group",
            clientKey: "H",
            children: [{ type: "text", x: 0, y: 20, content: "Hi" }],
          },
        ],
      },
      { type: "layer", name: "Layer 2" },
    ]);
    return { doc, L, G: keyMap.G as string, R: keyMap.R as string };
  };

  it("returns only the Layers at depth 1, with their real childCount", () => {
    const { doc } = fixture();
    expect(outline(doc, { depth: 1 })).toEqual([
      expect.objectContaining({ type: "layer", name: "Layer 1", childCount: 2 }),
      expect.objectContaining({ type: "layer", name: "Layer 2", childCount: 0 }),
    ]);
    expect(outline(doc, { depth: 1 }).some((n) => "children" in n)).toBe(false);
  });

  it("starts at rootId's children, counting depth from there", () => {
    const { doc, G, R } = fixture();
    const nodes = outline(doc, { rootId: G, depth: 1 });
    expect(nodes.map((n) => [n.type, n.childCount])).toEqual([
      ["rect", 0],
      ["group", 1],
    ]);
    expect(nodes[1]).not.toHaveProperty("children");
    expect(outline(doc, { rootId: R })).toEqual([]);
  });

  it("rejects an unknown rootId with NODE_NOT_FOUND at rootId", () => {
    const { doc } = fixture();
    expect(codeOf(() => outline(doc, { rootId: "01NOPE" }))).toMatchObject({
      code: "NODE_NOT_FOUND",
      path: "rootId",
    });
  });

  it("keeps the listed types and their ancestors, and every top-level Layer", () => {
    const { doc } = fixture();
    const [one, two] = outline(doc, { depth: 4, types: ["text"] });
    expect(one).toMatchObject({ childCount: 2, children: [{ type: "group", childCount: 2 }] });
    expect(one?.children?.[0]?.children).toMatchObject([
      { type: "group", children: [{ type: "text" }] },
    ]);
    expect(two).toMatchObject({ name: "Layer 2", childCount: 0 });
    // Within depth 2 no text is reached: the Layer keeps an empty list.
    expect(outline(doc, { types: ["text"] })[0]?.children).toEqual([]);
  });

  it("leaves bounds out with includeBounds: false", () => {
    const { doc } = fixture();
    const all = (nodes: OutlineNode[]): OutlineNode[] =>
      nodes.flatMap((n) => [n, ...all(n.children ?? [])]);
    expect(all(outline(doc, { depth: 4 })).every((n) => "bounds" in n)).toBe(true);
    const bare = all(outline(doc, { depth: 4, includeBounds: false }));
    expect(bare).toHaveLength(7);
    expect(bare.some((n) => "bounds" in n)).toBe(false);
  });
});

describe("a Clipping Mask (ADR-0021)", () => {
  const masked = () => {
    const { doc, defaultLayerId: layerId } = newDoc();
    const [group, , clip] = createNodes(doc, [
      {
        type: "group",
        parentId: layerId,
        children: [
          { type: "rect", x: 0, y: 0, width: 100, height: 100 },
          { type: "ellipse", x: 40, y: 40, width: 20, height: 20 },
        ],
      },
    ]).nodes;
    if (!group || !clip) throw new Error("setup");
    doc.nodes.set(clip.id, { ...clip, clipping: true } as typeof clip);
    return { doc, group, clip };
  };

  it("is bounded by its Clipping Path's geometry, visible bounds too", () => {
    const { doc, group } = masked();
    const clipBox = { x: 40, y: 40, width: 20, height: 20 };
    expect(bounds(doc, group)).toEqual(clipBox);
    expect(visibleBounds(doc, group)).toEqual(clipBox);
    expect(nodeView(doc, group, "concise").geometricBounds).toEqual(clipBox);
  });

  it("becomes an ordinary Group when its Clipping Path is deleted", () => {
    const { doc, group, clip } = masked();
    doc.nodes.delete(clip.id);
    expect(bounds(doc, group)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it("shows clipping on the Clipping Path in node_get full", () => {
    const { doc, clip } = masked();
    expect(nodeView(doc, doc.nodes.get(clip.id) ?? clip, "full")).toMatchObject({
      clipping: true,
    });
  });
});

describe("an Image", () => {
  const ID = "a".repeat(64);
  const withImage = () => {
    const made = newDoc();
    made.doc.images.set(ID, { mime: "image/png", width: 24, height: 16 });
    return made;
  };
  const image = (parentId: string, extra: object = {}) => ({
    type: "image" as const,
    parentId,
    src: ID,
    x: 10,
    y: 20,
    ...extra,
  });

  it("takes the file's pixel size as its frame, stretches by default and has no Appearance", () => {
    const { doc, defaultLayerId } = withImage();
    const [node] = createNodes(doc, [image(defaultLayerId)]).nodes;
    expect(node).toMatchObject({
      type: "image",
      src: ID,
      x: 10,
      y: 20,
      width: 24,
      height: 16,
      preserveAspectRatio: "none",
    });
    expect(node).not.toHaveProperty("appearance");
    const frame = { x: 10, y: 20, width: 24, height: 16 };
    expect(bounds(doc, node as Node)).toEqual(frame);
    expect(visibleBounds(doc, node as Node)).toEqual(frame);
    const full = nodeView(doc, node as Node, "full");
    expect(full).toMatchObject({ src: ID });
    expect(full).not.toHaveProperty("d");
  });

  it("keeps a frame given whole and spells preserveAspectRatio one way", () => {
    const { doc, defaultLayerId } = withImage();
    const [node] = createNodes(doc, [
      image(defaultLayerId, { width: 48, height: 48, preserveAspectRatio: "defer xMidYMid" }),
    ]).nodes;
    expect(node).toMatchObject({ width: 48, height: 48, preserveAspectRatio: "xMidYMid meet" });
  });

  it("is created inline in a Group", () => {
    const { doc, defaultLayerId } = withImage();
    const { nodes } = createNodes(doc, [
      { type: "group", parentId: defaultLayerId, children: [image(defaultLayerId)] },
    ]);
    expect(nodes.map((n) => n.type)).toEqual(["group", "image"]);
  });

  it("wants both width and height, or neither", () => {
    const { doc, defaultLayerId } = withImage();
    expect(() => createNodes(doc, [image(defaultLayerId, { width: 5 })])).toThrow(
      expect.objectContaining({ issues: [expect.objectContaining({ path: ["height"] })] }),
    );
  });

  it.each([
    ["an id the Document does not hold", "b".repeat(64), /No image/],
    ["a data: URL nobody read in", "data:image/png;base64,AAAA", /not read/],
  ])("refuses %s as src", (_, src, message) => {
    const { doc, defaultLayerId } = withImage();
    expect(codeOf(() => createNodes(doc, [image(defaultLayerId, { src })]))).toMatchObject({
      code: "INVALID_IMAGE",
      message: expect.stringMatching(message),
      path: "nodes[0].src",
      hint: expect.stringContaining("PNG"),
    });
  });
});

describe("container Appearance (ADR-0043)", () => {
  const stroke = (width: number) => ({ color: "#FF0000", width });

  it("stores appearance on a Layer, a Group and an inline Group, and nothing when omitted", () => {
    const { doc, defaultLayerId } = newDoc();
    const [layer, group, inner, plain] = createNodes(doc, [
      { type: "layer", appearance: { strokes: [stroke(2)] } },
      {
        type: "group",
        parentId: defaultLayerId,
        appearance: { fills: [{ color: "#00FF00" }], contents: 1 },
        children: [{ type: "group", appearance: { strokes: [stroke(1)] }, children: [] }],
      },
      { type: "group", parentId: defaultLayerId },
    ]).nodes;
    expect(layer).toMatchObject({
      appearance: { fills: [], strokes: [{ width: 2 }], contents: 0 },
    });
    expect(group).toMatchObject({
      appearance: { fills: [{ type: "solid", color: "#00FF00" }], strokes: [], contents: 1 },
    });
    expect(inner).toMatchObject({ appearance: { strokes: [{ color: "#FF0000", width: 1 }] } });
    expect(plain).not.toHaveProperty("appearance");
    if (!plain) throw new Error("setup");
    expect((nodeView(doc, plain, "full") as { appearance?: unknown }).appearance).toEqual({
      fills: [],
      strokes: [],
      contents: 0,
    });
  });

  it("refuses contents outside the stack with INVALID_INPUT at its path", () => {
    const { doc, defaultLayerId } = newDoc();
    const group = (contents: number) => ({
      type: "group" as const,
      parentId: defaultLayerId,
      children: [{ type: "group" as const, appearance: { strokes: [stroke(1)], contents } }],
    });
    for (const contents of [-1, 2]) {
      expect(codeOf(() => createNodes(doc, [group(contents)]))).toMatchObject({
        code: "INVALID_INPUT",
        path: "nodes[0].children[0].appearance.contents",
      });
    }
    expect(createNodes(doc, [group(1)]).nodes).toHaveLength(2);
  });

  it("lists the leaves it paints depth first, texts too, skipping hidden Nodes, Images and Clipping Paths", () => {
    const { doc, defaultLayerId } = newDoc();
    doc.images.set("i", { width: 1, height: 1, mediaType: "image/png" } as never);
    const [group, a, inner, b, hidden, , p, t, clip, clipped] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        children: [
          rect(defaultLayerId),
          {
            type: "group",
            children: [
              { ...rect(defaultLayerId), x: 100 },
              { ...rect(defaultLayerId), name: "hidden" },
              { type: "image", src: "i", x: 0, y: 0 },
            ],
          },
          { type: "path", d: "M 0 0 L 10 0 L 10 10 Z", fillRule: "evenodd" },
          { type: "text", x: 0, y: 50, content: "Hi" },
          rect(defaultLayerId),
          rect(defaultLayerId),
        ],
      } as never,
    ]).nodes;
    if (!group || !a || !inner || !b || !hidden || !p || !t || !clip || !clipped)
      throw new Error("setup");
    const mask = makeMask(doc, { clipNodeId: clip.id, contentIds: [clipped.id] }).group;
    transformNodes(doc, { nodeIds: [b.id], translate: { x: 5 } });
    doc.nodes.set(hidden.id, { ...hidden, visible: false });
    const leaves = paintedLeaves(doc, group);
    expect(leaves.map((l) => [l.node.id, l.fillRule, l.clips.map((c) => c.maskId)])).toEqual([
      [a.id, "nonzero", []],
      [b.id, "nonzero", []],
      [p.id, "evenodd", []],
      [t.id, "nonzero", []],
      [clipped.id, "nonzero", [mask.id]],
    ]);
    expect(leaves[1]?.segments[0]).toMatchObject({ cmd: "M", args: [105, 10] });
    // A text's outline is its frame; a clip's is its Clipping Path's, here the same rect.
    expect(leaves[3]?.segments.map((s) => s.cmd)).toEqual(["M", "L", "L", "L", "Z"]);
    expect(leaves[4]?.clips[0]?.segments).toEqual(leaves[4]?.segments);
    doc.nodes.set(inner.id, { ...inner, visible: false });
    expect(paintedLeaves(doc, group).map((l) => l.node.id)).toEqual([a.id, p.id, t.id, clipped.id]);
  });

  it("grows visibleBounds by half the widest container Stroke, never geometricBounds", () => {
    const { doc, defaultLayerId } = newDoc();
    const [group] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        appearance: { strokes: [stroke(4), stroke(10)] },
        children: [{ ...rect(defaultLayerId), appearance: {} }],
      },
    ]).nodes;
    if (!group) throw new Error("setup");
    expect(bounds(doc, group)).toEqual({ x: 10, y: 10, width: 50, height: 30 });
    expect(visibleBounds(doc, group)).toEqual({ x: 5, y: 5, width: 60, height: 40 });
  });

  it("cuts the Stroke on an inner Clipping Mask's leaf to its Clipping Path in visibleBounds", () => {
    const { doc, defaultLayerId } = newDoc();
    const box = (x: number) => ({ type: "rect" as const, x, y: 0, width: 10, height: 10 });
    const [group, clipped, clip] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        appearance: { strokes: [stroke(4)] },
        children: [box(20), box(25)],
      },
    ]).nodes;
    if (!group || !clipped || !clip) throw new Error("setup");
    makeMask(doc, { clipNodeId: clip.id, contentIds: [clipped.id] });
    // Grown on every side the leaf would reach 18; its clip, which the mask reports, starts at 25.
    expect(visibleBounds(doc, group)).toEqual({ x: 25, y: 0, width: 10, height: 10 });
  });

  it("grows visibleBounds around an Area Type child's frame by half the container Stroke (#112)", () => {
    const { doc, defaultLayerId } = newDoc();
    const [group] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        appearance: { strokes: [stroke(10)] },
        children: [
          {
            type: "text",
            kind: "area",
            x: 10,
            y: 20,
            width: 60,
            height: 15,
            content: "one\ntwo\nthree",
            appearance: {},
          },
        ],
      },
    ]).nodes;
    if (!group) throw new Error("setup");
    // The overflowing lines are not drawn, so the frame bounds the text however long it runs.
    expect(visibleBounds(doc, group)).toEqual({ x: 5, y: 15, width: 70, height: 25 });
  });

  it("grows visibleBounds around a text child by half the container Stroke", () => {
    const { doc, defaultLayerId } = newDoc();
    const [group, text] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        appearance: { strokes: [stroke(10)] },
        children: [{ type: "text", x: 10, y: 50, content: "Hi", appearance: {} }],
      },
    ]).nodes;
    if (!group || !text) throw new Error("setup");
    const b = bounds(doc, text);
    if (!b) throw new Error("setup");
    expect(visibleBounds(doc, group)).toEqual({
      x: b.x - 5,
      y: b.y - 5,
      width: b.width + 10,
      height: b.height + 10,
    });
  });
});

describe("container gradients (#107)", () => {
  const stops = [
    { offset: 0, color: "#000000" },
    { offset: 1, color: "#FFFFFF" },
  ];
  const fill = (gradient: object) => ({
    type: "gradient" as const,
    gradient: { stops, ...gradient },
  });
  const box = (x: number, y: number) => ({ type: "rect" as const, x, y, width: 20, height: 10 });
  const group = (
    parentId: string,
    appearance: object,
    children: object[] = [box(0, 0), box(80, 30)],
  ) => ({ type: "group", parentId, appearance, children }) as never;

  it("spans the Group's geometric bounds, its inline children's included", () => {
    const { doc, defaultLayerId } = newDoc();
    const [g] = createNodes(doc, [
      group(defaultLayerId, {
        fills: [fill({ type: "linear" }), fill({ type: "linear", angle: 90 })],
        strokes: [{ ...fill({ type: "radial" }), width: 3, cap: "round", dash: [2, 1] }],
      }),
    ]).nodes;
    // Bounds 0,0 100×40.
    expect(g).toMatchObject({
      appearance: {
        fills: [
          { gradient: { type: "linear", start: { x: 0, y: 20 }, end: { x: 100, y: 20 } } },
          { gradient: { type: "linear", start: { x: 50, y: 0 }, end: { x: 50, y: 40 } } },
        ],
        strokes: [
          {
            width: 3,
            cap: "round",
            dash: [2, 1],
            gradient: {
              type: "radial",
              center: { x: 50, y: 20 },
              radius: Math.round(Math.sqrt((100 ** 2 + 40 ** 2) / 8) * 1000) / 1000,
              aspectRatio: 1,
              angle: 0,
              focus: { x: 50, y: 20 },
            },
          },
        ],
      },
    });
    expect((nodeView(doc, g as Node, "full") as { appearance?: unknown }).appearance).toEqual(
      (g as { appearance: unknown }).appearance,
    );
    // The paint leaves the bounds alone.
    expect(bounds(doc, g as Node)).toEqual({ x: 0, y: 0, width: 100, height: 40 });
  });

  it("needs explicit geometry on a Group without bounds, and takes it", () => {
    const { doc, defaultLayerId } = newDoc();
    for (const [gradient, list] of [
      [{ type: "linear" }, "fills"],
      [{ type: "radial", center: { x: 1, y: 1 } }, "strokes"],
    ] as const) {
      expect(
        codeOf(() => createNodes(doc, [group(defaultLayerId, { [list]: [fill(gradient)] }, [])])),
      ).toMatchObject({
        code: "INVALID_INPUT",
        path: `nodes[0].appearance.${list}[0].gradient`,
        hint: expect.stringContaining("start and end"),
      });
    }
    const [g] = createNodes(doc, [
      group(
        defaultLayerId,
        { fills: [fill({ type: "radial", center: { x: 1, y: 2 }, radius: 3 })] },
        [],
      ),
    ]).nodes;
    expect(g).toMatchObject({
      appearance: {
        fills: [{ gradient: { center: { x: 1, y: 2 }, radius: 3, focus: { x: 1, y: 2 } } }],
      },
    });
  });
});
