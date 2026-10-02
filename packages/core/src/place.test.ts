import { describe, expect, it } from "vitest";
import {
  bounds,
  childrenOf,
  createDocument,
  createNodes,
  union,
  visibleBounds,
} from "./document.ts";
import { makeMask } from "./mask.ts";
import { placeImage, placeNodes } from "./place.ts";
import type { Node, ShapeNode, Stroke, Warning } from "./schema.ts";
import { fileTextWarnings } from "./text.ts";

/** The Nodes of a file with two Layers, a rect in each and a sub-Layer in the first, as Open reads it. */
function file() {
  const { doc, defaultLayerId } = createDocument({ id: "f", name: "F", artboards: [] });
  const [second, sub] = createNodes(doc, [
    { type: "layer", name: "Top" },
    { type: "layer", parentId: defaultLayerId, name: "Sub" },
  ]).nodes as [Node, Node];
  const rect = (parentId: string, x: number) => ({
    type: "rect" as const,
    parentId,
    x,
    y: 0,
    width: 20,
    height: 10,
    appearance: { fills: [], strokes: [{ color: "#000000", width: 2 }] },
  });
  createNodes(doc, [rect(defaultLayerId, 0), rect(second.id, 20), rect(sub.id, 30)]);
  return { name: "Logo", nodes: [...doc.nodes.values()] };
}

const setup = (artboards = [{ width: 200, height: 100 }]) =>
  createDocument({ id: "d", name: "Doc", artboards });

describe("placeNodes", () => {
  it("puts the file's Layers, as Groups with new ids, into one Group above the parent's children", () => {
    const { doc, defaultLayerId } = setup();
    createNodes(doc, [{ type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 5, height: 5 }]);
    const f = file();
    const {
      placedIds: [groupId = ""],
      created,
    } = placeNodes(doc, f, { parentId: defaultLayerId });

    const group = doc.nodes.get(groupId) as Node;
    expect(group).toMatchObject({ type: "group", name: "Logo", parentId: defaultLayerId });
    expect(childrenOf(doc, defaultLayerId).at(-1)?.id).toBe(groupId);
    expect(created[0]?.id).toBe(groupId);
    expect(created).toHaveLength(f.nodes.length + 1);
    const kids = childrenOf(doc, groupId);
    expect(kids.map((n) => [n.type, n.name])).toEqual([
      ["group", "Layer 1"],
      ["group", "Top"],
    ]);
    const sub = childrenOf(doc, kids[0]?.id as string).find((n) => n.name === "Sub");
    expect(sub?.type).toBe("group");
    expect(created.some((n) => n.type === "layer")).toBe(false);
    const old = new Set(f.nodes.map((n) => n.id));
    expect(created.filter((n) => old.has(n.id))).toEqual([]);
    // What `created` carries is what the Document holds, transformed leaves included.
    for (const n of created) expect(doc.nodes.get(n.id)).toEqual(n);
  });

  it("centres the Group on the parent's Artboard by default, or on position", () => {
    const { doc, defaultLayerId } = setup();
    const [groupId = ""] = placeNodes(doc, file(), { parentId: defaultLayerId }).placedIds;
    // The file's rects span x 0..50, y 0..10.
    expect(bounds(doc, doc.nodes.get(groupId) as Node)).toEqual({
      x: 75,
      y: 45,
      width: 50,
      height: 10,
    });
    const at = placeNodes(doc, file(), { parentId: defaultLayerId, position: { x: 10, y: 20 } });
    expect(bounds(doc, doc.nodes.get(at.placedIds[0] as string) as Node)).toEqual({
      x: -15,
      y: 15,
      width: 50,
      height: 10,
    });
  });

  it("fit scales uniformly, Strokes included, to fit the parent's Artboard", () => {
    const { doc, defaultLayerId } = setup();
    const {
      placedIds: [groupId = ""],
      created,
    } = placeNodes(doc, file(), { parentId: defaultLayerId, fit: true });
    const b = bounds(doc, doc.nodes.get(groupId) as Node);
    expect(b?.x).toBeCloseTo(0);
    expect(b?.y).toBeCloseTo(30);
    expect(b?.width).toBeCloseTo(200);
    expect(b?.height).toBeCloseTo(40);
    const leaf = created.find((n) => n.type === "rect") as ShapeNode;
    expect(leaf.appearance.strokes[0]?.width).toBe(2);
    expect(visibleBounds(doc, leaf)?.height).toBeCloseTo(40 + 8);
  });

  it("keeps a container's Appearance on the Groups it places, a Layer's too, fit scaling its Strokes", () => {
    const { doc, defaultLayerId } = setup();
    const f = file();
    const layer = f.nodes.find((n) => n.name === "Top") as Node;
    const [stroke] = (f.nodes.find((n) => n.type === "rect") as ShapeNode).appearance.strokes;
    const appearance = {
      fills: [{ type: "solid" as const, color: "#00FF00" }],
      strokes: [{ ...(stroke as Stroke), width: 3 }],
      contents: 1,
    };
    f.nodes = f.nodes.map((n) => (n === layer ? ({ ...n, appearance } as Node) : n));
    const { created } = placeNodes(doc, f, { parentId: defaultLayerId, fit: true });
    const placed = created.find((n) => n.name === "Top");
    expect(placed).toMatchObject({
      type: "group",
      appearance: { ...appearance, strokes: [{ width: 12 }] },
    });
  });

  it("uses the Artboard the parent overlaps most, else the first", () => {
    const { doc, defaultLayerId } = setup([
      { width: 200, height: 100 },
      { width: 100, height: 100 },
    ]);
    // An empty parent: the first Artboard.
    const first = placeNodes(doc, file(), { parentId: defaultLayerId });
    expect(bounds(doc, doc.nodes.get(first.placedIds[0] as string) as Node)?.x).toBe(75);

    const [layer] = createNodes(doc, [{ type: "layer", name: "Right" }]).nodes as [Node];
    // The second Artboard sits at x 220..320.
    createNodes(doc, [{ type: "rect", parentId: layer.id, x: 230, y: 10, width: 5, height: 5 }]);
    const second = placeNodes(doc, file(), { parentId: layer.id });
    expect(bounds(doc, doc.nodes.get(second.placedIds[0] as string) as Node)).toMatchObject({
      x: 245,
      y: 45,
    });
  });

  it("places an empty file as an empty Group", () => {
    const { doc, defaultLayerId } = setup();
    const empty = createDocument({ id: "e", name: "E", artboards: [] }).doc;
    const {
      placedIds: [groupId = ""],
      created,
    } = placeNodes(
      doc,
      { name: "Empty", nodes: [...empty.nodes.values()] },
      { parentId: defaultLayerId, fit: true },
    );
    expect(created.map((n) => n.type)).toEqual(["group", "group"]);
    expect(childrenOf(doc, groupId)).toHaveLength(1);
  });

  it("follows node_create's parent rule", () => {
    const { doc, defaultLayerId } = setup();
    const [rect] = createNodes(doc, [
      { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 5, height: 5 },
    ]).nodes as [Node];
    expect(() => placeNodes(doc, file(), { parentId: rect.id })).toThrow(
      expect.objectContaining({ data: expect.objectContaining({ code: "INVALID_PARENT" }) }),
    );
    expect(() => placeNodes(doc, file(), { parentId: doc.artboards[0]?.id as string })).toThrow(
      expect.objectContaining({ data: expect.objectContaining({ code: "INVALID_PARENT" }) }),
    );
    expect(() => placeNodes(doc, file(), { parentId: "nope" })).toThrow(
      expect.objectContaining({ data: expect.objectContaining({ code: "NODE_NOT_FOUND" }) }),
    );
  });

  it("keeps a file's own coordinates with inPlace", () => {
    const { doc, defaultLayerId } = setup();
    const [groupId = ""] = placeNodes(doc, file(), {
      parentId: defaultLayerId,
      position: { x: 500, y: 500 },
      inPlace: true,
    }).placedIds;
    expect(bounds(doc, doc.nodes.get(groupId) as Node)).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 10,
    });
  });
});

describe("placeNodes of a nodes-scope copy", () => {
  /** A copy of rects a (in a Group in Layer 1) and d (in Layer Top), as export writes it. */
  function copy() {
    const { doc, defaultLayerId } = createDocument({ id: "c", name: "C", artboards: [] });
    const [top, group] = createNodes(doc, [
      { type: "layer", name: "Top" },
      { type: "group", parentId: defaultLayerId, children: [] },
    ]).nodes as [Node, Node];
    const [a, d] = createNodes(doc, [
      { type: "rect", parentId: group.id, name: "a", x: 0, y: 0, width: 10, height: 10 },
      { type: "rect", parentId: top.id, name: "d", x: 30, y: 20, width: 10, height: 10 },
    ]).nodes as [Node, Node];
    return { name: "C", nodes: [...doc.nodes.values()], a, d, group };
  }

  it("places the listed Nodes directly in the parent, above its children, in stacking order, with new ids", () => {
    const { doc, defaultLayerId } = setup();
    const [old] = createNodes(doc, [
      { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 5, height: 5 },
    ]).nodes as [Node];
    const { a, d, ...f } = copy();
    const { placedIds, created } = placeNodes(
      doc,
      { ...f, scope: { nodeIds: [d.id, a.id] } },
      { parentId: defaultLayerId },
    );
    expect(childrenOf(doc, defaultLayerId).map((n) => n.name)).toEqual(["", "a", "d"]);
    expect(childrenOf(doc, defaultLayerId)[0]?.id).toBe(old.id);
    expect(created.map((n) => n.name)).toEqual(["a", "d"]);
    expect(placedIds).toEqual(created.map((n) => n.id));
    expect(placedIds).not.toContain(a.id);
    for (const n of created) expect(doc.nodes.get(n.id)).toEqual(n);
    // Centred on the Artboard as one: they span 0..40, 0..30.
    expect(union(created.map((n) => bounds(doc, n)))).toEqual({
      x: 80,
      y: 35,
      width: 40,
      height: 30,
    });
  });

  it("keeps the file's coordinates with inPlace, and a listed Group's contents", () => {
    const { doc, defaultLayerId } = setup();
    const { a, d, group, ...f } = copy();
    const { placedIds, created } = placeNodes(
      doc,
      { ...f, scope: { nodeIds: [group.id, a.id, d.id] } },
      { parentId: defaultLayerId, inPlace: true },
    );
    expect(created.map((n) => [n.type, n.name])).toEqual([
      ["group", ""],
      ["rect", "d"],
      ["rect", "a"],
    ]);
    expect(placedIds).toEqual([created[0]?.id, created[1]?.id]);
    expect(bounds(doc, created[2] as Node)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("keeps what an edit elsewhere added beside the listed Nodes, and Groups a file that lists none of its own", () => {
    const { doc, defaultLayerId } = setup();
    const { a, d, group, ...f } = copy();
    const extra = { ...a, id: "z-extra", name: "extra", index: `${a.index}V` };
    const { created } = placeNodes(
      doc,
      { ...f, nodes: [...f.nodes, extra], scope: { nodeIds: [a.id] } },
      { parentId: defaultLayerId },
    );
    // Top leads to no listed Node, so it comes as a Group.
    expect(created.map((n) => [n.type, n.name])).toEqual([
      ["rect", "a"],
      ["rect", "extra"],
      ["group", "Top"],
      ["rect", "d"],
    ]);
    expect(childrenOf(doc, defaultLayerId).map((n) => n.name)).toEqual(["a", "extra", "Top"]);

    const grouped = placeNodes(
      doc,
      { ...f, scope: { nodeIds: ["z-gone"] } },
      { parentId: defaultLayerId },
    );
    expect(grouped.created[0]).toMatchObject({ type: "group", name: "C" });
    expect(grouped.placedIds).toEqual([grouped.created[0]?.id]);
  });
});

it("keeps a placed Clipping Mask clipping under its new ids", () => {
  const f = createDocument({ id: "f", name: "F", artboards: [] });
  const [content, clip] = createNodes(f.doc, [
    { type: "rect", parentId: f.defaultLayerId, x: 0, y: 0, width: 20, height: 20 },
    { type: "ellipse", parentId: f.defaultLayerId, x: 5, y: 5, width: 4, height: 4 },
  ]).nodes as [Node, Node];
  makeMask(f.doc, { clipNodeId: clip.id, contentIds: [content.id] });
  const { doc, defaultLayerId } = setup();
  const { created } = placeNodes(
    doc,
    { name: "Clip", nodes: [...f.doc.nodes.values()] },
    {
      parentId: defaultLayerId,
      fit: false,
    },
  );
  const placed = created.find((n) => n.type === "ellipse") as ShapeNode;
  expect(placed).toMatchObject({ clipping: true });
  expect(placed.id).not.toBe(clip.id);
  expect(doc.nodes.get(placed.parentId ?? "")?.type).toBe("group");
});

describe("Layer Clipping Masks (ADR-0053)", () => {
  /** A file whose Layer is clipped by its topmost ellipse, over a rect `a` and a sublayer's rect. */
  function clippedLayer() {
    const f = createDocument({ id: "f", name: "F", artboards: [] });
    const [sub, a] = createNodes(f.doc, [
      { type: "layer", parentId: f.defaultLayerId },
      { type: "rect", parentId: f.defaultLayerId, name: "a", x: 0, y: 0, width: 20, height: 20 },
      {
        type: "ellipse",
        parentId: f.defaultLayerId,
        name: "clip",
        x: 5,
        y: 5,
        width: 4,
        height: 4,
      },
    ]).nodes as [Node, Node, Node];
    createNodes(f.doc, [{ type: "rect", parentId: sub.id, x: 0, y: 0, width: 9, height: 9 }]);
    const [clip] = makeMask(f.doc, { layerId: f.defaultLayerId }).updated as [Node];
    return { name: "F", nodes: [...f.doc.nodes.values()], a, clip };
  }

  it("places a clipped Layer as a Clip Group", () => {
    const { doc, defaultLayerId } = setup();
    const { a: _, clip, ...f } = clippedLayer();
    const { created } = placeNodes(doc, f, { parentId: defaultLayerId, fit: false });
    const placed = created.find((n) => n.name === "clip") as ShapeNode;
    expect(placed).toMatchObject({ clipping: true });
    expect(doc.nodes.get(placed.parentId ?? "")?.type).toBe("group");
    expect(created.some((n) => n.type === "layer")).toBe(false);
  });

  it("pastes content copied out of a clipped Layer unclipped, without its Clipping Path", () => {
    const { doc, defaultLayerId } = setup();
    const { a, clip: _, ...f } = clippedLayer();
    const { created } = placeNodes(
      doc,
      { ...f, scope: { nodeIds: [a.id] } },
      { parentId: defaultLayerId },
    );
    expect(created.map((n) => n.name)).toContain("a");
    expect(created.map((n) => n.name)).not.toContain("clip");
    expect(childrenOf(doc, defaultLayerId).some((n) => "clipping" in n && n.clipping)).toBe(false);
  });

  it("pastes a listed Clipping Path as an ordinary Path", () => {
    const { doc, defaultLayerId } = setup();
    const { a, clip, ...f } = clippedLayer();
    const { created } = placeNodes(
      doc,
      { ...f, scope: { nodeIds: [a.id, clip.id] } },
      { parentId: defaultLayerId },
    );
    const pasted = created.find((n) => n.name === "clip");
    expect(pasted).toMatchObject({ type: "ellipse", parentId: defaultLayerId });
    expect(pasted).not.toHaveProperty("clipping");
  });
});

describe("placeImage", () => {
  const src = "a".repeat(64);
  const withImage = () => {
    const d = setup();
    d.doc.images.set(src, { mime: "image/png", width: 2, height: 2 });
    return d;
  };

  it("centres the file's pixel size on the parent's Artboard, or takes the frame", () => {
    const { doc, defaultLayerId } = withImage();
    const { created } = placeImage(doc, { src, name: "red.png" }, { parentId: defaultLayerId });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: "image",
      parentId: defaultLayerId,
      src,
      x: 99,
      y: 49,
      width: 2,
      height: 2,
      opacity: 1,
    });
    const at = placeImage(
      doc,
      { src, name: "" },
      { parentId: defaultLayerId, frame: { x: 10, y: 20 } },
    );
    expect(at.created[0]).toMatchObject({ x: 10, y: 20, width: 2, height: 2 });
    const sized = placeImage(
      doc,
      { src, name: "" },
      { parentId: defaultLayerId, frame: { x: 1, y: 2, width: 30, height: 40 } },
    );
    expect(sized.created[0]).toMatchObject({ x: 1, y: 2, width: 30, height: 40 });
  });

  it("sizes and centres an oriented file upright, on the Artboard or on position (ADR-0101)", () => {
    const { doc, defaultLayerId } = setup();
    doc.images.set(src, { mime: "image/jpeg", width: 8, height: 4 });
    const file = { src, name: "photo.jpg", orientation: 6 as const };
    const [centred] = placeImage(doc, file, { parentId: defaultLayerId }).created as [Node];
    expect(centred).toMatchObject({
      x: 96,
      y: 48,
      width: 8,
      height: 4,
      transform: [0, 1, -1, 0, 150, -50],
    });
    expect(bounds(doc, centred)).toEqual({ x: 98, y: 46, width: 4, height: 8 });
    const [at] = placeImage(doc, file, { parentId: defaultLayerId, position: { x: 10, y: 10 } })
      .created as [Node];
    expect(bounds(doc, at)).toEqual({ x: 8, y: 6, width: 4, height: 8 });
    const [framed] = placeImage(doc, file, { parentId: defaultLayerId, frame: { x: 1, y: 2 } })
      .created as [Node];
    expect(bounds(doc, framed)).toEqual({ x: 1, y: 2, width: 4, height: 8 });
  });

  it("asTemplate puts it at 50% on a locked Layer beneath the Layer that holds the parent", () => {
    const { doc, defaultLayerId } = withImage();
    const [top, group] = createNodes(doc, [
      { type: "layer", name: "Top" },
      { type: "group", parentId: defaultLayerId, children: [] },
    ]).nodes as [Node, Node];
    const { created } = placeImage(
      doc,
      { src, name: "photo.png" },
      { parentId: group.id, asTemplate: true },
    );
    const [layer, image] = created as [Node, Node];
    expect(layer).toMatchObject({
      type: "layer",
      name: "Template photo.png",
      locked: true,
      template: true,
      parentId: null,
    });
    expect(image).toMatchObject({ type: "image", parentId: layer.id, opacity: 0.5, x: 99, y: 49 });
    expect(childrenOf(doc, null).map((n) => n.id)).toEqual([layer.id, defaultLayerId, top.id]);
    for (const n of created) expect(doc.nodes.get(n.id)).toEqual(n);
  });

  it("refuses a parent that cannot hold an Image, under parentId", () => {
    const { doc, defaultLayerId } = withImage();
    const [rect] = createNodes(doc, [
      { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 5, height: 5 },
    ]).nodes as [Node];
    for (const parentId of [rect.id, doc.artboards[0]?.id as string]) {
      expect(() => placeImage(doc, { src, name: "" }, { parentId })).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({ code: "INVALID_PARENT", path: "parentId" }),
        }),
      );
    }
  });
});

describe("placeNodes' warnings", () => {
  const warn = (code: string, nodeId?: string) => ({
    code,
    message: code,
    ...(nodeId && { nodeId }),
  });

  it("name the copied Nodes by their new ids, never the new Group, and keep one without a nodeId in order", () => {
    const { doc, defaultLayerId } = setup();
    const f = file();
    const top = f.nodes.find((n) => n.name === "Top") as Node;
    const rect = f.nodes.find((n) => n.parentId === top.id) as Node;
    const { placedIds, created, warnings } = placeNodes(
      doc,
      { ...f, warnings: [warn("A", rect.id), warn("B"), warn("C", top.id)] },
      { parentId: defaultLayerId },
    );
    const group = created.find((n) => n.name === "Top") as Node;
    const copy = created.find((n) => n.parentId === group.id) as Node;
    expect(warnings).toEqual([warn("A", copy.id), warn("B"), warn("C", group.id)]);
    expect(warnings.map((w) => w.nodeId)).not.toContain(placedIds[0]);
  });

  it("drop those on Nodes a Kalamo copy leaves behind, and keep a listed Clipping Path's", () => {
    const { doc, defaultLayerId } = setup();
    const f = createDocument({ id: "f", name: "F", artboards: [] });
    const [group] = createNodes(f.doc, [
      { type: "group", parentId: f.defaultLayerId, children: [] },
    ]).nodes as [Node];
    const [a, b, clip] = createNodes(f.doc, [
      { type: "rect", parentId: group.id, name: "a", x: 0, y: 0, width: 20, height: 20 },
      { type: "rect", parentId: group.id, name: "b", x: 0, y: 0, width: 20, height: 20 },
      { type: "ellipse", parentId: group.id, name: "clip", x: 5, y: 5, width: 4, height: 4 },
    ]).nodes as [Node, Node, Node];
    makeMask(f.doc, { clipNodeId: clip.id, contentIds: [a.id, b.id] });
    const nodes = [...f.doc.nodes.values()];
    const mask = nodes.find((n) => n.type === "group" && n.id !== group.id) as Node;
    const warnings = [
      warn("LAYER", f.defaultLayerId),
      warn("GROUP", group.id),
      warn("MASK", mask.id),
      warn("CLIP", clip.id),
      warn("A", a.id),
      warn("FILE"),
    ];
    const paste = (nodeIds: string[]) =>
      placeNodes(
        doc,
        { name: "F", nodes, warnings, scope: { nodeIds } },
        { parentId: defaultLayerId },
      );

    const left = paste([a.id]);
    expect(left.warnings).toEqual([warn("A", left.created[0]?.id), warn("FILE")]);
    const listed = paste([a.id, clip.id]);
    const id = (name: string) => listed.created.find((n) => n.name === name)?.id;
    expect(listed.warnings).toEqual([warn("CLIP", id("clip")), warn("A", id("a")), warn("FILE")]);
  });
});

describe("placeNodes' per-file text warnings (#162)", () => {
  /** A file whose text Clipping Path masks `art`, with a `kept` text, in `order`, as Open warns it. */
  type Face = { fontFamily: string; content: string };
  function copy(clip: Face, kept: Face, order: "clip first" | "kept first") {
    const f = createDocument({ id: "f", name: "F", artboards: [] });
    const text = (name: string, face: Face) => ({
      type: "text" as const,
      parentId: f.defaultLayerId,
      name,
      x: 0,
      y: 20,
      ...face,
    });
    const [c, k, art] = createNodes(f.doc, [
      text("clip", clip),
      text("kept", kept),
      { type: "rect", parentId: f.defaultLayerId, x: 0, y: 0, width: 40, height: 40 },
    ]).nodes as [Node, Node, Node];
    makeMask(f.doc, { clipNodeId: c.id, contentIds: [art.id] });
    const texts = (order === "clip first" ? [c, k] : [k, c]).map(
      (n) => f.doc.nodes.get(n.id) as Node,
    );
    const rest = [...f.doc.nodes.values()].filter((n) => n.type !== "text");
    const nodes = [...texts, ...rest];
    const reader: Warning = { code: "UNSUPPORTED_PAINT", message: "p" };
    const warnings = [reader, ...fileTextWarnings(nodes)];
    return { nodes, warnings, reader, clipId: c.id, keptId: k.id, artId: art.id };
  }
  const clip = { fontFamily: "Helvetica", content: "กข" };
  const paste = (f: ReturnType<typeof copy>, nodeIds?: string[]) => {
    const { doc, defaultLayerId } = setup();
    return placeNodes(
      doc,
      { name: "F", nodes: f.nodes, warnings: f.warnings, ...(nodeIds && { scope: { nodeIds } }) },
      { parentId: defaultLayerId },
    );
  };

  for (const order of ["clip first", "kept first"] as const) {
    it(`count the texts a Kalamo copy places, not the Clipping Path it leaves behind (${order})`, () => {
      const f = copy(clip, { fontFamily: "Helvetica", content: "ค" }, order);
      const placed = paste(f, [f.artId, f.keptId]);
      const kept = placed.created.find((n) => n.name === "kept")?.id;
      expect(placed.warnings).toEqual([
        f.reader,
        { code: "FONT_MISSING", nodeId: kept, message: expect.stringMatching(/^Helvetica is/) },
        {
          code: "MISSING_GLYPHS",
          nodeId: kept,
          message: expect.stringContaining("has glyphs for ค;"),
        },
      ]);
    });

    it(`warn nothing for a face or characters only the left-behind text has (${order})`, () => {
      const f = copy(clip, { fontFamily: "Source Sans 3", content: "Kept" }, order);
      expect(paste(f, [f.artId, f.keptId]).warnings).toEqual([f.reader]);
    });
  }

  it("give a full-file Place Open's warnings, renamed to the copies", () => {
    const f = copy(clip, { fontFamily: "Arial", content: "ค" }, "clip first");
    const placed = paste(f);
    const copyOf = (name: string) => placed.created.find((n) => n.name === name)?.id;
    const renamed = { [f.clipId]: copyOf("clip"), [f.keptId]: copyOf("kept") };
    expect(placed.warnings).toEqual(
      f.warnings.map((w) => (w.nodeId ? { ...w, nodeId: renamed[w.nodeId] } : w)),
    );
    expect(placed.warnings.map((w) => w.code)).toEqual([
      "UNSUPPORTED_PAINT",
      "FONT_MISSING",
      "FONT_MISSING",
      "MISSING_GLYPHS",
    ]);
  });
});
