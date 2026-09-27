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
import type { Node, ShapeNode, Stroke } from "./schema.ts";

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
