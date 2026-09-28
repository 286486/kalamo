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
import { editableShapes, marqueeAnchors, pick } from "./direct.ts";
import { exitLevel, goTo, inScope, isolate, levels, prune } from "./isolation.ts";
import { layerMask, rows } from "./layers.ts";
import { receive } from "./receive.ts";
import { hitTest, inverse, marquee, objectOf, placeParent } from "./selection.ts";
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
  it("takes an editable Group, and refuses a leaf, a Layer and a hidden or locked Group", () => {
    const { doc, id, set } = fixture();
    expect(isolate(doc, id("inner"))).toBe(id("inner"));
    expect(isolate(doc, id("outer"))).toBe(id("outer"));
    expect(isolate(doc, id("x"))).toBeNull();
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
