import {
  createDocument,
  createNodes,
  type Document,
  deleteNodes,
  makeMask,
  type Node,
  releaseMask,
} from "@zibel/core";
import type { TxMessage } from "@zibel/sync";
import { describe, expect, it } from "vitest";
import { boxContext } from "./boxContext.ts";
import { editableShapes, marqueeAnchors, parseKey, pick } from "./direct.ts";
import { exitLevel, forNewArt, goTo, inScope, isolate, levels, prune } from "./isolation.ts";
import { layerIsolation, layerMask, rows } from "./layers.ts";
import { receive } from "./receive.ts";
import { hitTest, inverse, marquee, objectOf, objects, placeParent } from "./selection.ts";
import { endpointAt } from "./tools.ts";

/** Layer 1: Clip Group outer (clip, content, Group inner (rect x)), rect bg. */
function fixture() {
  const { doc, defaultLayerId: layer } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const rect = (clientKey: string) =>
    ({ type: "rect", clientKey, x: 0, y: 0, width: 10, height: 10 }) as const;
  const { keyMap } = createNodes(doc, [
    { ...rect("bg"), parentId: layer },
    { ...rect("content"), parentId: layer },
    { type: "group", clientKey: "inner", parentId: layer, children: [rect("x")] },
    { ...rect("clip"), parentId: layer },
  ]);
  const id = (key: string) => keyMap[key] as string;
  const { group } = makeMask(doc, {
    clipNodeId: id("clip"),
    contentIds: [id("content"), id("inner")],
  });
  keyMap.outer = group.id;
  keyMap.layer = layer;
  const set = (key: string, patch: Partial<Node>) =>
    doc.nodes.set(id(key), { ...(doc.nodes.get(id(key)) as Node), ...patch } as Node);
  return { doc, id, set };
}

const copy = (doc: Document): Document => ({ ...doc, nodes: new Map(doc.nodes) });

describe("isolate", () => {
  it("takes an editable Group, and refuses a Clipping Path, a Layer and a hidden or locked Group", () => {
    const { doc, id, set } = fixture();
    expect(isolate(doc, id("inner"))).toBe(id("inner"));
    expect(isolate(doc, id("outer"))).toBe(id("outer"));
    expect(isolate(doc, id("clip"))).toBeNull();
    expect(isolate(doc, id("layer"))).toBeNull();
    set("inner", { visible: false });
    expect(isolate(doc, id("inner"))).toBeNull();
    set("inner", { visible: true });
    set("outer", { locked: true });
    expect(isolate(doc, id("inner"))).toBeNull();
    set("outer", { locked: false });
    set("layer", { locked: true });
    expect(isolate(doc, id("outer"))).toBeNull();
  });
});

it("derives the levels from the tree, from below the Layer down", () => {
  const { doc, id } = fixture();
  expect(levels(doc, id("inner"))).toEqual([id("outer"), id("inner")]);
  expect(levels(doc, "gone")).toEqual([]);
});

it("keeps the scope to what is below the isolated Group", () => {
  const { doc, id } = fixture();
  const node = (key: string) => doc.nodes.get(id(key)) as Node;
  expect(inScope(doc, node("x"), id("outer"))).toBe(true);
  expect(inScope(doc, node("clip"), id("outer"))).toBe(true);
  expect(inScope(doc, node("outer"), id("outer"))).toBe(false);
  expect(inScope(doc, node("bg"), id("outer"))).toBe(false);
  expect(inScope(doc, node("bg"), null)).toBe(true);
});

it("goes up one level and selects the Group it left", () => {
  const { doc, id } = fixture();
  expect(exitLevel(doc, id("inner"))).toEqual({ isolated: id("outer"), selection: [id("inner")] });
  expect(exitLevel(doc, id("outer"))).toEqual({ isolated: null, selection: [id("outer")] });
});

it("goes to a breadcrumb's level, or leaves from the Layer's, selecting the level left", () => {
  const { doc, id } = fixture();
  expect(goTo(doc, id("inner"), id("outer"))).toEqual({
    isolated: id("outer"),
    selection: [id("inner")],
  });
  expect(goTo(doc, id("inner"), null)).toEqual({ isolated: null, selection: [id("outer")] });
});

describe("prune", () => {
  it("keeps a level that is still an editable Group", () => {
    const { doc, id } = fixture();
    expect(prune(doc, copy(doc), id("inner"))).toBe(id("inner"));
    expect(prune(doc, doc, null)).toBeNull();
  });

  it("moves up when the isolated Group is deleted, reading its levels from before", () => {
    const { doc, id } = fixture();
    const next = copy(doc);
    deleteNodes(next, [id("inner")]);
    expect(prune(doc, next, id("inner"))).toBe(id("outer"));
  });

  it("ends when its parent is deleted with it", () => {
    const { doc, id } = fixture();
    const next = copy(doc);
    deleteNodes(next, [id("outer")]);
    expect(prune(doc, next, id("inner"))).toBeNull();
  });

  it("moves above a level hidden or locked, itself or through an ancestor", () => {
    const { doc, id, set } = fixture();
    const prev = copy(doc);
    set("inner", { visible: false });
    expect(prune(prev, doc, id("inner"))).toBe(id("outer"));
    set("inner", { visible: true });
    set("outer", { locked: true });
    expect(prune(prev, doc, id("inner"))).toBeNull();
  });

  it("keeps a Clip Group released or without its Clipping Path, now a plain Group", () => {
    const { doc, id } = fixture();
    const released = copy(doc);
    releaseMask(released, [id("clip")]);
    expect(prune(doc, released, id("outer"))).toBe(id("outer"));
    const unclipped = copy(doc);
    deleteNodes(unclipped, [id("clip")]);
    expect(prune(doc, unclipped, id("outer"))).toBe(id("outer"));
  });

  it("runs on every incoming change, such as an undo that removes the Group", () => {
    const { doc, id } = fixture();
    const state = {
      doc,
      selection: [],
      isolated: id("inner"),
      drag: null,
      pen: null,
      pending: [],
      edit: null,
      opPreview: null,
      anchors: [],
      segments: [],
      notice: null,
    };
    const tx = (extra: Partial<TxMessage>): TxMessage => ({
      type: "tx",
      rev: doc.rev + 1,
      txId: "t",
      actor: "user",
      intent: "undo",
      created: [],
      updated: [],
      deletedIds: [],
      ...extra,
    });
    expect(receive(state, tx({}), "d")?.isolated).toBe(id("inner"));
    expect(receive(state, tx({ deletedIds: [id("inner"), id("x")] }), "d")?.isolated).toBe(
      id("outer"),
    );
    const everything = [id("outer"), id("clip"), id("content"), id("inner"), id("x")];
    expect(receive(state, tx({ deletedIds: everything }), "d")?.isolated).toBeNull();
  });
});

describe("a sub-Layer or a single path (ADR-0058)", () => {
  /**
   * Layer L: rect bg (0–200 × 0–100), sub-Layer S, rect top (150–170 × 60–80). S, clipped by the
   * Layer Clipping Mask clip (10–110 × 10–60): sub-Layer T (rect t 60–70, path p 80–90, rect far
   * 120–130, all × 20–30), rect a (20–30), Group g (rect gx 40–50), text, clip.
   */
  function layered() {
    const { doc, defaultLayerId: l } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const rect = (clientKey: string, x: number, y = 20, width = 10, height = 10) =>
      ({ type: "rect", clientKey, x, y, width, height }) as const;
    const { keyMap } = createNodes(doc, [
      { ...rect("bg", 0, 0, 200, 100), parentId: l },
      { type: "layer", clientKey: "S", name: "S", parentId: l },
      { ...rect("top", 150, 60, 20, 20), parentId: l },
    ]);
    const id = (key: string) => keyMap[key] as string;
    Object.assign(
      keyMap,
      createNodes(doc, [
        { type: "layer", clientKey: "T", name: "T", parentId: id("S") },
        { ...rect("a", 20), parentId: id("S") },
        { type: "group", clientKey: "g", parentId: id("S"), children: [rect("gx", 40)] },
        { type: "text", clientKey: "text", parentId: id("S"), x: 20, y: 50, content: "Hi" },
        { ...rect("clip", 10, 10, 100, 50), parentId: id("S") },
      ]).keyMap,
    );
    Object.assign(
      keyMap,
      createNodes(doc, [
        { ...rect("t", 60), parentId: id("T") },
        { type: "path", clientKey: "p", parentId: id("T"), d: "M 80 20 L 90 30" },
        { ...rect("far", 120), parentId: id("T") },
      ]).keyMap,
    );
    makeMask(doc, { layerId: id("S") });
    keyMap.L = l;
    const set = (key: string, patch: Partial<Node>) =>
      doc.nodes.set(id(key), { ...(doc.nodes.get(id(key)) as Node), ...patch } as Node);
    const node = (key: string) => doc.nodes.get(id(key)) as Node;
    return { doc, id, set, node };
  }
  const all = { x: -5, y: -5, width: 300, height: 300 };
  const sorted = (ids: string[]) => [...ids].sort();

  it("isolates a sub-Layer, a Live Shape and a Path, and nothing else", () => {
    const { doc, id, set } = layered();
    for (const key of ["S", "T", "a", "p", "gx"]) expect(isolate(doc, id(key))).toBe(id(key));
    for (const key of ["L", "text", "clip"]) expect(isolate(doc, id(key))).toBeNull();
    const image = createNodes(doc, [
      { type: "image", parentId: id("S"), x: 0, y: 0, width: 2, height: 2, file: "a.png" },
    ]).nodes[0] as Node;
    expect(isolate(doc, image.id)).toBeNull();
    set("a", { locked: true });
    expect(isolate(doc, id("a"))).toBeNull();
    set("T", { visible: false });
    expect(isolate(doc, id("T"))).toBeNull();
    expect(isolate(doc, id("p"))).toBeNull();
    set("S", { locked: true });
    expect(isolate(doc, id("S"))).toBeNull();
  });

  it("counts every sub-Layer and Group down to the isolated Node as a level", () => {
    const { doc, id } = layered();
    expect(levels(doc, id("g"))).toEqual([id("S"), id("g")]);
    expect(levels(doc, id("gx"))).toEqual([id("S"), id("g"), id("gx")]);
    expect(levels(doc, id("p"))).toEqual([id("S"), id("T"), id("p")]);
    expect(levels(doc, id("L"))).toEqual([]);
  });

  it("exits a Group in a sub-Layer to the sub-Layer, then leaves with nothing selected", () => {
    const { doc, id } = layered();
    expect(exitLevel(doc, id("g"))).toEqual({ isolated: id("S"), selection: [id("g")] });
    expect(exitLevel(doc, id("S"))).toEqual({ isolated: null, selection: [] });
    expect(exitLevel(doc, id("p"))).toEqual({ isolated: id("T"), selection: [id("p")] });
    expect(goTo(doc, id("p"), id("S"))).toEqual({ isolated: id("S"), selection: [] });
    expect(goTo(doc, id("gx"), id("S"))).toEqual({ isolated: id("S"), selection: [id("g")] });
  });

  it("scopes clicks to a sub-Layer, its nested sub-Layers included, inside its clip", () => {
    const ctx = boxContext();
    const { doc, id } = layered();
    const hit = (x: number, y: number) => hitTest(ctx, doc, x, y, 1, { scope: id("S") });
    expect(hit(25, 25)).toBe(id("a"));
    expect(hit(45, 25)).toBe(id("g"));
    expect(hit(65, 25)).toBe(id("t"));
    // bg and top are outside S; far is outside S's Clipping Path.
    expect(hit(5, 5)).toBeNull();
    expect(hit(160, 70)).toBeNull();
    expect(hit(125, 25)).toBeNull();
    expect(hitTest(ctx, doc, 45, 25, 1, { leaf: true, scope: id("S") })).toBe(id("gx"));
  });

  it("hits an isolated clipped sub-Layer's unpainted Clipping Path on its outline, not inside", () => {
    const ctx = boxContext();
    const { doc, id } = layered();
    expect(hitTest(ctx, doc, 10.4, 40, 1, { scope: id("S") })).toBe(id("clip"));
    expect(hitTest(ctx, doc, 15, 40, 1, { scope: id("S") })).toBeNull();
    expect(hitTest(ctx, doc, 10.4, 40, 1, { scope: null })).toBe(id("bg"));
  });

  it("keeps a marquee, Select All and Inverse in a sub-Layer", () => {
    const { doc, id } = layered();
    const inS = sorted(["t", "p", "far", "a", "g", "text", "clip"].map(id));
    expect(sorted(marquee(doc, all, id("S")))).toEqual(inS);
    expect(sorted(objects(doc, id("S")).map((n) => n.id))).toEqual(inS);
    expect(sorted(inverse(doc, [id("a")], id("S")))).toEqual(inS.filter((x) => x !== id("a")));
  });

  it("makes an isolated leaf its scope's only object", () => {
    const ctx = boxContext();
    const { doc, id, node } = layered();
    const scope = id("a");
    expect(hitTest(ctx, doc, 25, 25, 1, { scope })).toBe(scope);
    expect(hitTest(ctx, doc, 45, 25, 1, { scope })).toBeNull();
    expect(hitTest(ctx, doc, 5, 5, 1, { scope })).toBeNull();
    expect(hitTest(ctx, doc, 25, 25, 1, { leaf: true, scope })).toBe(scope);
    expect(objectOf(doc, node("a"), scope)?.id).toBe(scope);
    expect(marquee(doc, all, scope)).toEqual([scope]);
    expect(objects(doc, scope).map((n) => n.id)).toEqual([scope]);
    expect(inverse(doc, [], scope)).toEqual([scope]);
    expect(inverse(doc, [scope], scope)).toEqual([]);
    const nodes = (keys: string[]) => [...new Set(keys.map((k) => parseKey(k).nodeId))];
    expect(nodes(marqueeAnchors(doc, all, scope))).toEqual([scope]);
    expect(editableShapes(doc, scope).map((n) => n.id)).toEqual([scope]);
    // gx's corner is outside the scope.
    expect(pick(doc, { selection: [], anchors: [], x: 40, y: 20, tolerance: 1, scope })).toBeNull();
    expect(
      pick(doc, { selection: [], anchors: [], x: 20, y: 20, tolerance: 1, scope }),
    ).toMatchObject({ kind: "anchor" });
  });

  it("places new art in the sub-Layer, or in the nested Layer holding the first selected Node", () => {
    const { doc, id } = layered();
    const scope = id("S");
    expect(placeParent(doc, [], scope)).toBe(scope);
    expect(placeParent(doc, [id("a")], scope)).toBe(scope);
    expect(placeParent(doc, [id("t")], scope)).toBe(id("T"));
    expect(placeParent(doc, [id("bg")], scope)).toBe(scope);
    expect(placeParent(doc, [id("gx")], id("g"))).toBe(id("g"));
    expect(placeParent(doc, [id("t")], null)).toBe(id("T"));
  });

  it("leaves an isolated leaf one level up for new art, into its parent", () => {
    const { doc, id } = layered();
    const at = (key: string) => {
      const s = forNewArt(doc, { isolated: id(key), selection: [id(key)] });
      return { ...s, parent: placeParent(doc, s.selection, s.isolated) };
    };
    expect(at("a")).toEqual({ isolated: id("S"), selection: [id("a")], parent: id("S") });
    expect(at("gx")).toEqual({ isolated: id("g"), selection: [id("gx")], parent: id("g") });
    expect(at("bg")).toEqual({ isolated: null, selection: [id("bg")], parent: id("L") });
    expect(at("p")).toEqual({ isolated: id("T"), selection: [id("p")], parent: id("T") });
    expect(forNewArt(doc, { isolated: id("S"), selection: [] })).toEqual({
      isolated: id("S"),
      selection: [],
    });
  });

  describe("prune", () => {
    it("moves up from a leaf deleted, made a Clipping Path, or replaced", () => {
      const { doc, id, set } = layered();
      const deleted = copy(doc);
      deleteNodes(deleted, [id("a")]);
      expect(prune(doc, deleted, id("a"))).toBe(id("S"));
      const prev = copy(doc);
      set("a", { clipping: true } as Partial<Node>);
      expect(prune(prev, doc, id("a"))).toBe(id("S"));
      set("a", { clipping: undefined } as Partial<Node>);
      // A Path operation or Convert to Path deletes the leaf and creates its replacement.
      const replaced = copy(doc);
      deleteNodes(replaced, [id("p")]);
      createNodes(replaced, [{ type: "path", parentId: id("T"), d: "M 80 20 L 90 30" }]);
      expect(prune(doc, replaced, id("p"))).toBe(id("T"));
    });

    it("moves above a sub-Layer hidden, locked or deleted", () => {
      const { doc, id, set } = layered();
      const prev = copy(doc);
      set("T", { visible: false });
      expect(prune(prev, doc, id("p"))).toBe(id("S"));
      set("T", { visible: true });
      set("S", { locked: true });
      expect(prune(prev, doc, id("t"))).toBeNull();
      set("S", { locked: false });
      const deleted = copy(doc);
      deleteNodes(deleted, [id("T")]);
      expect(prune(doc, deleted, id("T"))).toBe(id("S"));
      expect(prune(doc, deleted, id("p"))).toBe(id("S"));
    });

    it("keeps a clipped sub-Layer isolated when its mask is released", () => {
      const { doc, id } = layered();
      const released = copy(doc);
      releaseMask(released, [id("S")]);
      expect(prune(doc, released, id("S"))).toBe(id("S"));
    });

    it("runs on an undo that removes the isolated leaf", () => {
      const { doc, id } = layered();
      const state = {
        doc,
        selection: [id("a")],
        isolated: id("a"),
        drag: null,
        pen: null,
        pending: [],
        edit: null,
        opPreview: null,
        anchors: [],
        segments: [],
        notice: null,
      };
      const tx: TxMessage = {
        type: "tx",
        rev: doc.rev + 1,
        txId: "t",
        actor: "user",
        intent: "undo",
        created: [],
        updated: [],
        deletedIds: [id("a")],
      };
      expect(receive(state, tx, "d")?.isolated).toBe(id("S"));
    });
  });

  describe("the Layers panel", () => {
    it("lists an isolated sub-Layer expanded at depth 0, and an isolated leaf alone", () => {
      const { doc, id } = layered();
      const listed = rows(doc, new Set([id("S")]), id("S"));
      expect(listed[0]).toMatchObject({ node: { id: id("S") }, depth: 0, expanded: true });
      expect(listed.map((r) => r.node.id)).toContain(id("t"));
      expect(listed.map((r) => r.node.id)).not.toContain(id("bg"));
      expect(rows(doc, new Set(), id("a"))).toEqual([expect.objectContaining({ depth: 0 })]);
      expect(rows(doc, new Set(), id("a"))[0]?.node.id).toBe(id("a"));
    });

    it("isolates the deepest Layer holding the Selection when it is a sub-Layer in scope", () => {
      const { doc, id } = layered();
      const inS = objects(doc, id("S")).map((n) => n.id);
      // A click on S's row selects its objects, the first of them in T.
      expect(inS[0]).toBe(id("t"));
      expect(layerIsolation(doc, inS, null)).toEqual({
        label: "Enter Isolation Mode for S",
        target: id("S"),
      });
      expect(layerIsolation(doc, [id("t"), id("p")], null).target).toBe(id("T"));
      expect(layerIsolation(doc, [id("bg")], null).target).toBeNull();
      expect(layerIsolation(doc, [id("bg"), id("a")], null).target).toBeNull();
      expect(layerIsolation(doc, [], null)).toEqual({
        label: "Enter Isolation Mode",
        target: null,
      });
      expect(layerIsolation(doc, [id("gx")], id("g")).target).toBeNull();
      expect(layerIsolation(doc, [id("a")], id("a")).target).toBeNull();
      expect(layerIsolation(doc, inS, id("S")).target).toBeNull();
      expect(layerIsolation(doc, [id("t"), id("p")], id("S")).target).toBe(id("T"));
    });

    it("makes and releases the sub-Layer's mask in its scope, and not in a Group or leaf's", () => {
      const { doc, id } = layered();
      expect(layerMask(doc, [], id("S")).command).toEqual({
        type: "mask_release",
        nodeIds: [id("S")],
      });
      expect(layerMask(doc, [id("t")], id("S")).command).toEqual({
        type: "mask_make",
        input: { layerId: id("T") },
      });
      expect(layerMask(doc, [id("gx")], id("g")).command).toBeNull();
      expect(layerMask(doc, [id("a")], id("a")).command).toBeNull();
    });
  });
});

// Compile-time only, never run: no selection helper defaults its scope, so widening it (#130)
// makes the compiler find every caller.
declare const d: Document, n: Node, ctx: CanvasRenderingContext2D;
const r = { x: 0, y: 0, width: 0, height: 0 };
void (() => {
  // @ts-expect-error scope is required
  objectOf(d, n);
  // @ts-expect-error scope is required
  placeParent(d, []);
  // @ts-expect-error scope is required
  hitTest(ctx, d, 0, 0, 1);
  // @ts-expect-error scope is required
  hitTest(ctx, d, 0, 0, 1, { leaf: true });
  // @ts-expect-error scope is required
  marquee(d, r);
  // @ts-expect-error scope is required
  inverse(d, []);
  // @ts-expect-error scope is required
  editableShapes(d);
  // @ts-expect-error scope is required
  pick(d, { selection: [], anchors: [], x: 0, y: 0, tolerance: 1 });
  // @ts-expect-error scope is required
  marqueeAnchors(d, r);
  // @ts-expect-error scope is required
  endpointAt(d, [0, 0], 1, undefined);
  // @ts-expect-error scope is required
  rows(d, new Set());
  // @ts-expect-error scope is required
  layerMask(d, []);
});
