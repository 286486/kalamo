import { describe, expect, it } from "vitest";
import { createDocument, createNodes } from "./document.ts";
import { KalamoError } from "./errors.ts";
import type { Node, NodeInput } from "./schema.ts";
import { type ValidateOptions, validate } from "./validate.ts";

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof KalamoError) return e.data;
    throw e;
  }
  throw new Error("expected a KalamoError");
};

/**
 * One 100 × 100 Artboard at 0, 0 and the Nodes under its Layer; `issues` gives each issue's rule and
 * the index of its Node in `nodes`, -1 for one inside them.
 */
function scene(nodes: object[]) {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 100, height: 100 }],
  });
  const ids = createNodes(
    doc,
    nodes.map((n) => ({ ...n, parentId: defaultLayerId }) as NodeInput),
  )
    .nodes.filter((n) => n.parentId === defaultLayerId)
    .map((n) => n.id);
  const issues = (opts?: ValidateOptions) =>
    validate(doc, opts).map((i) => [i.rule, ids.indexOf(i.nodeId)]);
  return { doc, layerId: defaultLayerId, ids, issues };
}

const rect = (x: number, y: number, width = 10, height = 10) =>
  ({ type: "rect", x, y, width, height }) as const;
const area = (height: number, content = "Hello\nworld") =>
  ({ type: "text", kind: "area", x: 0, y: 0, width: 60, height, content, fontSize: 12 }) as const;

describe("validate", () => {
  it("text_overflow: Area Type whose content does not all fit, not text that fits exactly", () => {
    // autoSize fits the frame's height to the lines.
    const fitted = (content: string) => {
      const { doc, ids } = scene([{ ...area(0, content), height: undefined, autoSize: true }]);
      return (doc.nodes.get(ids[0] as string) as { height: number }).height;
    };
    const { issues } = scene([area(fitted("Hello\nworld")), area(fitted("Hello"))]);
    expect(issues()).toEqual([["text_overflow", 1]]);
  });

  it("font_missing and missing_glyphs: a text's own warnings, one issue each", () => {
    const { issues } = scene([
      { type: "text", x: 0, y: 20, content: "Hi", fontFamily: "Helvetica" },
      { type: "text", x: 0, y: 40, content: "กข" },
      { type: "text", x: 0, y: 60, content: "Hi" },
    ]);
    expect(issues()).toEqual([
      ["font_missing", 0],
      ["missing_glyphs", 1],
    ]);
  });

  it("outside_artboards: a Node off every Artboard, not one half on, nor the Nodes in it", () => {
    const { issues } = scene([
      rect(200, 200),
      rect(95, 95),
      // Its Stroke reaches the Artboard's edge.
      { ...rect(100.5, 0), appearance: { strokes: [{ color: "#000000", width: 1 }] } },
      { type: "group", children: [rect(300, 0), rect(320, 0)] },
    ]);
    expect(issues()).toEqual([
      ["outside_artboards", 0],
      ["outside_artboards", 3],
    ]);
  });

  it("zero_area: a point, or a closed shape on one line; not a Line of zero height", () => {
    const { issues } = scene([
      rect(10, 10, 20, 0),
      { type: "path", d: "M 10 10 L 30 30 L 20 20 Z" },
      { type: "path", d: "M 50 50" },
      { type: "line", x1: 10, y1: 50, x2: 50, y2: 50 },
      { type: "path", d: "M 10 10 L 30 30 L 20 20" },
      { type: "ellipse", x: 10, y: 10, width: 0, height: 20 },
      rect(10, 10, 20, 0.01),
    ]);
    expect(issues()).toEqual([
      ["zero_area", 0],
      ["zero_area", 1],
      ["zero_area", 2],
      ["zero_area", 5],
    ]);
  });

  it("zero_area: a closed shape whose outline cancels itself, though its bounds have area", () => {
    const square = "M 0 0 L 10 0 L 10 10 L 0 10 Z";
    const { issues } = scene([
      // Out and back along the same lines, then along the same curve.
      { type: "path", d: "M 0 0 L 10 0 L 10 10 L 10 0 Z" },
      { type: "path", d: "M 0 0 C 0 20 20 20 20 0 C 20 20 0 20 0 0 Z" },
      // A square and the same square wound the other way.
      { type: "path", d: `${square} M 0 0 L 0 10 L 10 10 L 10 0 Z` },
      // Traced twice: evenodd fills nothing, nonzero fills it.
      { type: "path", d: `${square} ${square}`, fillRule: "evenodd" },
      { type: "path", d: `${square} ${square}` },
      // Its open subpath is closed as a fill closes it, back along itself.
      { type: "path", d: "M 0 0 L 10 0 L 10 10 L 10 0 Z M 20 20 L 30 20" },
      // A bowtie's signed area is zero, but both lobes fill.
      { type: "path", d: "M 0 0 L 10 10 L 10 0 L 0 10 Z" },
      // Out along one curve and back along another.
      { type: "path", d: "M 0 0 C 0 20 20 20 20 0 C 20 10 0 10 0 0 Z" },
      // Tiny, but it fills.
      rect(10, 10, 0.5, 0.5),
    ]);
    expect(issues()).toEqual([
      ["zero_area", 0],
      ["zero_area", 1],
      ["zero_area", 2],
      ["zero_area", 3],
      ["zero_area", 5],
    ]);
  });

  it("missing_link: a linked Image with no pixels", () => {
    const { issues } = scene([
      { type: "image", file: "gone.png", x: 0, y: 0, width: 10, height: 10 },
    ]);
    expect(issues()).toEqual([["missing_link", 0]]);
  });

  it("empty_group: a Group with no children, not one with a child", () => {
    const { issues } = scene([
      { type: "group", children: [] },
      { type: "group", children: [rect(0, 0)] },
    ]);
    expect(issues()).toEqual([["empty_group", 0]]);
  });

  it("skips hidden Nodes and Template Layers, with what they contain", () => {
    const { doc, ids, issues } = scene([
      { type: "group", children: [] },
      { type: "group", children: [{ type: "group", children: [] }] },
      { type: "group", children: [] },
    ]);
    const [template] = createNodes(doc, [
      { type: "layer", name: "Template", template: true },
    ]).nodes;
    createNodes(doc, [{ type: "group", parentId: template?.id, children: [] }]);
    for (const id of ids.slice(0, 2)) {
      doc.nodes.set(id, { ...(doc.nodes.get(id) as Node), visible: false });
    }
    expect(issues()).toEqual([["empty_group", 2]]);
    // Listed, a Node inside a hidden one is still skipped.
    const inner = doc.nodes.get(ids[1] as string) as Node & { children: string[] };
    const hiddenChild = [...doc.nodes.values()].find((n) => n.parentId === inner.id) as Node;
    expect(issues({ scope: { nodeIds: [hiddenChild.id] } })).toEqual([]);
  });

  it("lists issues in drawing order, bottom first, then a Node's by rule", () => {
    const { issues } = scene([
      { type: "group", children: [] },
      { type: "text", x: 200, y: 0, content: "กข", fontFamily: "Helvetica" },
      rect(10, 10, 0, 0),
    ]);
    expect(issues()).toEqual([
      ["empty_group", 0],
      ["font_missing", 1],
      ["missing_glyphs", 1],
      ["outside_artboards", 1],
      ["zero_area", 2],
    ]);
  });

  it("rules keeps only the named rules", () => {
    const { issues } = scene([{ type: "group", children: [] }, rect(200, 0, 0, 0)]);
    expect(issues({ rules: ["zero_area"] })).toEqual([["zero_area", 1]]);
  });

  it("scope {nodeIds}: those Nodes and what they contain", () => {
    const { ids, issues } = scene([
      { type: "group", children: [] },
      { type: "group", children: [rect(0, 0, 0, 0)] },
      rect(200, 0),
    ]);
    expect(issues({ scope: { nodeIds: [ids[1] as string, ids[2] as string] } })).toEqual([
      ["zero_area", -1],
      ["outside_artboards", 2],
    ]);
    expect(errorOf(() => validate(scene([]).doc, { scope: { nodeIds: ["nope"] } }))).toMatchObject({
      code: "NODE_NOT_FOUND",
      path: "scope.nodeIds[0]",
    });
  });

  it("scope {artboardId}: the Nodes touching that Artboard, never outside_artboards", () => {
    const { doc, issues } = scene([rect(50, 50, 0, 0), rect(200, 200, 0, 0)]);
    const artboardId = doc.artboards[0]?.id as string;
    expect(issues({ scope: { artboardId } })).toEqual([["zero_area", 0]]);
    expect(errorOf(() => validate(doc, { scope: { artboardId: "nope" } }))).toMatchObject({
      code: "ARTBOARD_NOT_FOUND",
      path: "scope.artboardId",
    });
  });
});
