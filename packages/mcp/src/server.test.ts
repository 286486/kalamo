import {
  COLOR_PATTERN,
  createDocument,
  createNodes,
  KalamoError,
  LEGACY_NAME,
  type Node,
  nodeView,
  PathOpInput,
} from "@kalamo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harness } from "./harness.ts";

afterEach(() => vi.restoreAllMocks());

it("calls list with no arguments and returns the list as structuredContent and as text", async () => {
  const result = {
    documents: [
      { docId: "d", name: "Doc", createdAt: "2026-01-01T00:00:00Z", role: "owner" as const },
    ],
  };
  const { service, call } = await harness({ list: async () => result });
  expect(await call("kalamo_doc_list")).toEqual({
    structuredContent: result,
    content: [{ type: "text", text: JSON.stringify(result) }],
  });
  expect(service.list).toHaveBeenCalledWith();
});

it("doc_delete deletes by docId and returns the receipt", async () => {
  const { service, call } = await harness({
    delete: async (docId) => ({ docId, deleted: true }),
  });
  expect((await call("kalamo_doc_delete", { docId: "d" })).structuredContent).toEqual({
    docId: "d",
    deleted: true,
  });
  expect(service.delete).toHaveBeenCalledWith("d");
});

const receipt = {
  txId: "t",
  rev: 2,
  createdIds: [],
  updatedIds: [],
  deletedIds: [],
  keyMap: {},
  bounds: null,
  warnings: [],
};
const opts = { intent: "why", txId: "t", ifRev: 3 };
const writeOptions = [
  ["all", opts],
  ["some", { intent: opts.intent }],
  ["no", {}],
] as const;

describe("write tools pass the write and its options apart", () => {
  it("node_create: every type through the published union, with the schema defaults filled", async () => {
    const { service, call } = await harness({ createNodes: async () => receipt });
    const nodes = [
      { type: "layer", name: "L" },
      { type: "group", parentId: "p", children: [{ type: "line", x1: 0, y1: 0, x2: 1, y2: 1 }] },
      { type: "rect", parentId: "p", x: 0, y: 0, width: 10, height: 10 },
      { type: "ellipse", parentId: "p", x: 0, y: 0, width: 10, height: 10 },
      {
        type: "ellipse",
        parentId: "p",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        startAngle: 300,
        endAngle: 60,
        arcType: "chord",
      },
      { type: "polygon", parentId: "p", cx: 0, cy: 0, radius: 5, sides: 6 },
      {
        type: "star",
        parentId: "p",
        cx: 0,
        cy: 0,
        outerRadius: 5,
        innerRadius: 2,
        points: 5,
        twist: 10,
        rounded: 0.3,
        randomized: 0.1,
      },
      { type: "spiral", parentId: "p", cx: 0, cy: 0, radius: 9, revolution: 2.5, t0: 0.1 },
      { type: "path", parentId: "p", d: "M 0 0 L 1 1" },
      { type: "text", parentId: "p", x: 0, y: 0, content: "Hi" },
      {
        type: "text",
        kind: "area",
        parentId: "p",
        x: 0,
        y: 0,
        width: 50,
        height: 20,
        content: "a\nb",
      },
      { type: "image", parentId: "p", src: "data:image/png;base64,AAAA", x: 0, y: 0 },
    ];
    const result = await call("kalamo_node_create", { docId: "d", nodes, ...opts });
    expect(result.structuredContent).toEqual(receipt);
    const [docId, sent, options] = service.createNodes.mock.calls[0] ?? [];
    expect(docId).toBe("d");
    expect(options).toEqual({ ...opts, partial: false });
    expect(sent).toMatchObject([
      { type: "layer", name: "L" },
      { type: "group", children: [{ type: "line" }] },
      { type: "rect", radius: 0 },
      { type: "ellipse", startAngle: 0, endAngle: 360, arcType: "slice" },
      { type: "ellipse", startAngle: 300, endAngle: 60, arcType: "chord" },
      { type: "polygon", angle: 0, rounded: 0, randomized: 0 },
      { type: "star", angle: 0, twist: 10, rounded: 0.3, randomized: 0.1 },
      { type: "spiral", radius: 9, revolution: 2.5, expansion: 1, argument: 0, t0: 0.1 },
      { type: "path", fillRule: "nonzero" },
      { type: "text", kind: "point", fontFamily: "Source Sans 3", fontSize: 12 },
      { type: "text", kind: "area", width: 50, height: 20, content: "a\nb", fontSize: 12 },
      { type: "image", src: "data:image/png;base64,AAAA", preserveAspectRatio: "none" },
    ]);
    expect(sent?.[11]).not.toHaveProperty("appearance");
    await call("kalamo_node_create", { docId: "d", nodes: [nodes[2]] });
    expect(service.createNodes.mock.calls[1]?.[2]).toEqual({ partial: false });
  });

  it("node_create and node_update: a text's alignment arrives as sent, null included (ADR-0077)", async () => {
    const { service, call } = await harness({
      createNodes: async () => receipt,
      updateNodes: async () => receipt,
    });
    const text = { type: "text", parentId: "p", x: 0, y: 0, content: "Hi" };
    await call("kalamo_node_create", { docId: "d", nodes: [{ ...text, alignment: "center" }] });
    expect(service.createNodes.mock.calls[0]?.[1]).toMatchObject([{ alignment: "center" }]);
    const updates = [
      { nodeId: "t", patch: { alignment: "right" } },
      { nodeId: "t", patch: { alignment: null } },
    ];
    await call("kalamo_node_update", { docId: "d", updates });
    expect(service.updateNodes.mock.calls[0]?.[1]).toEqual(updates);
  });

  it("node_create: Area Type's frameNodeId arrives as sent, and the receipt reports what it deleted (ADR-0078)", async () => {
    const framed = {
      ...receipt,
      deletedIds: ["e"],
      warnings: [{ code: "TEXT_OVERFLOW", nodeId: "t", message: "3 characters do not fit." }],
    };
    const { service, call } = await harness({ createNodes: async () => framed });
    const item = { type: "text", kind: "area", parentId: "p", frameNodeId: "e", content: "Hi" };
    const result = await call("kalamo_node_create", { docId: "d", nodes: [item] });
    expect(result.structuredContent).toEqual(framed);
    expect(service.createNodes.mock.calls[0]?.[1]).toMatchObject([item]);
    const mixed = await call("kalamo_node_create", {
      docId: "d",
      nodes: [{ ...item, width: 10 }],
    });
    expect(errorOf(mixed)).toMatchObject({ code: "INVALID_INPUT", path: "nodes[0].width" });
  });

  it("node_create, node_update and node_get carry midpoints on a Fill and a Stroke, and refuse one on the last stop (ADR-0081)", async () => {
    const stops = [
      { offset: 0, color: "#000000", midpoint: 0.25 },
      { offset: 1, color: "#FFFFFF" },
    ];
    const fill = { type: "gradient", gradient: { type: "linear", stops } };
    const stroke = { type: "gradient", gradient: { type: "radial", stops }, width: 2 };
    // node_get's output schema checks a whole Node, so core builds one.
    const { doc, defaultLayerId } = createDocument({ id: "d", name: "D", artboards: [] });
    const [node] = createNodes(doc, [
      {
        type: "rect",
        parentId: defaultLayerId,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        appearance: { fills: [fill], strokes: [stroke] },
      } as never,
    ]).nodes;
    const { service, call } = await harness({
      createNodes: async () => receipt,
      updateNodes: async () => receipt,
      get: async () => ({ rev: 2, nodes: [nodeView(doc, node as Node, "full")] }),
    });
    const rect = { type: "rect", parentId: "p", x: 0, y: 0, width: 10, height: 10 };
    await call("kalamo_node_create", {
      docId: "d",
      nodes: [{ ...rect, appearance: { fills: [fill], strokes: [stroke] } }],
    });
    expect(service.createNodes.mock.calls[0]?.[1]).toMatchObject([
      { appearance: { fills: [{ gradient: { stops } }], strokes: [{ gradient: { stops } }] } },
    ]);
    const patch = { appearance: { fills: [fill], strokes: [stroke] } };
    await call("kalamo_node_update", { docId: "d", updates: [{ nodeId: "r", patch }] });
    expect(service.updateNodes.mock.calls[0]?.[1]).toMatchObject([{ nodeId: "r", patch }]);
    const got = await call("kalamo_node_get", { docId: "d", nodeIds: ["r"], detail: "full" });
    expect(got.structuredContent).toMatchObject({
      nodes: [
        { appearance: { fills: [{ gradient: { stops } }], strokes: [{ gradient: { stops } }] } },
      ],
    });
    const late = [stops[1], { ...stops[0], offset: 1 }];
    const refused = await call("kalamo_node_update", {
      docId: "d",
      updates: [
        {
          nodeId: "r",
          patch: {
            appearance: { strokes: [{ ...stroke, gradient: { type: "radial", stops: late } }] },
          },
        },
      ],
    });
    expect(errorOf(refused)).toMatchObject({
      code: "INVALID_INPUT",
      path: "updates[0].patch.appearance.strokes[0].gradient.stops[1].midpoint",
    });
    expect(service.updateNodes).toHaveBeenCalledTimes(1);
  });

  it("node_create: a linked image arrives with file, and src only when sent (ADR-0042)", async () => {
    const { service, call } = await harness({ createNodes: async () => receipt });
    const frame = { parentId: "p", x: 0, y: 0, width: 4, height: 2 };
    await call("kalamo_node_create", {
      docId: "d",
      nodes: [
        { type: "image", file: "a.png", ...frame },
        {
          type: "image",
          file: "b.png",
          src: "data:image/png;base64,AAAA",
          parentId: "p",
          x: 0,
          y: 0,
        },
      ],
    });
    const sent = service.createNodes.mock.calls[0]?.[1];
    expect(sent).toMatchObject([
      { type: "image", file: "a.png", width: 4, height: 2 },
      { type: "image", file: "b.png", src: "data:image/png;base64,AAAA" },
    ]);
    expect(sent?.[0]).not.toHaveProperty("src");
  });

  it("node_update: each patch arrives as sent, with no Node or Stroke defaults", async () => {
    const { service, call } = await harness({ updateNodes: async () => receipt });
    const updates = [
      { nodeId: "a", patch: { width: 60 } },
      { nodeId: "b", patch: { appearance: { fills: [{ color: "#FF0000" }] } } },
      { nodeId: "c", patch: { preserveAspectRatio: "xMidYMid meet" } },
      { nodeId: "d", patch: { src: "data:image/png;base64,AAAA", file: "a.png" } },
      { nodeId: "e", patch: { file: null } },
    ];
    await call("kalamo_node_update", { docId: "d", updates, ...opts });
    const [docId, sent, options] = service.updateNodes.mock.calls[0] ?? [];
    expect([docId, options]).toEqual(["d", { ...opts, partial: false }]);
    // Strict: a default filled in as an undefined key would still reach the Durable Object.
    expect(sent).toStrictEqual(updates);
  });

  it("node_delete", async () => {
    const { service, call } = await harness({ deleteNodes: async () => receipt });
    await call("kalamo_node_delete", { docId: "d", nodeIds: ["a", "b"], ...opts });
    expect(service.deleteNodes).toHaveBeenCalledWith("d", ["a", "b"], {
      ...opts,
      partial: false,
    });
  });

  it("node_transform: the transform gets none of the write options", async () => {
    const { service, call } = await harness({ transformNodes: async () => receipt });
    await call("kalamo_node_transform", {
      docId: "d",
      nodeIds: ["a"],
      rotate: 90,
      partial: true,
      ...opts,
    });
    const [docId, input, options] = service.transformNodes.mock.calls[0] ?? [];
    expect([docId, options]).toEqual(["d", { ...opts, partial: true }]);
    expect(input).toStrictEqual({
      nodeIds: ["a"],
      rotate: 90,
      pivot: "center",
      each: false,
      scaleStrokes: true,
    });
  });

  it("node_transform: transforms arrive as entries with their defaults, apart from the write options", async () => {
    const { service, call } = await harness({ transformNodes: async () => receipt });
    const transforms = [
      { nodeIds: ["a"], rotate: -7 },
      { nodeIds: ["b"], rotate: 6, pivot: "topLeft" },
    ];
    await call("kalamo_node_transform", { docId: "d", transforms, partial: true, ...opts });
    expect(service.transformNodes.mock.calls[0]).toStrictEqual([
      "d",
      {
        transforms: [
          { nodeIds: ["a"], rotate: -7, pivot: "center", each: false, scaleStrokes: true },
          { nodeIds: ["b"], rotate: 6, pivot: "topLeft", each: false, scaleStrokes: true },
        ],
      },
      { ...opts, partial: true },
    ]);
  });

  it("node_reparent: the moves as sent, apart from the write options", async () => {
    const { service, call } = await harness({ reparentNodes: async () => receipt });
    const moves = [
      { nodeId: "a", parentId: "g" },
      { nodeId: "b", parentId: null, index: 0 },
      { nodeId: "c", parentId: "g", after: "a" },
    ];
    await call("kalamo_node_reparent", { docId: "d", moves, ...opts });
    expect(service.reparentNodes.mock.calls[0]).toStrictEqual([
      "d",
      moves,
      { ...opts, partial: false },
    ]);
  });

  it.each(["front", "forward", "backward", "back"] as const)(
    "node_reorder: nodeIds and op %s as sent, apart from the write options",
    async (op) => {
      const { service, call } = await harness({ reorderNodes: async () => receipt });
      await call("kalamo_node_reorder", { docId: "d", nodeIds: ["a", "b"], op, ...opts });
      expect(service.reorderNodes.mock.calls[0]).toStrictEqual([
        "d",
        ["a", "b"],
        op,
        { ...opts, partial: false },
      ]);
    },
  );

  it("node_duplicate: nodeIds, offset, count and targetParentId as sent, apart from the write options", async () => {
    const copies = { a: ["a1", "a2"] };
    const geometricBounds = { a1: { x: 5, y: 0, width: 10, height: 10 }, a2: null };
    const { service, call } = await harness({
      duplicateNodes: async () => ({ ...receipt, copies, geometricBounds }),
    });
    const input = { nodeIds: ["a"], offset: { x: 5, y: 0 }, count: 2, targetParentId: "g" };
    const result = await call("kalamo_node_duplicate", { docId: "d", ...input, ...opts });
    expect(service.duplicateNodes.mock.calls[0]).toStrictEqual(["d", input, opts]);
    expect(result.structuredContent).toEqual({ ...receipt, copies, geometricBounds });
    await call("kalamo_node_duplicate", { docId: "d", nodeIds: ["a"], targetParentId: null });
    expect(service.duplicateNodes.mock.calls[1]).toStrictEqual([
      "d",
      { nodeIds: ["a"], targetParentId: null },
      {},
    ]);
  });

  it.each([1, 1000])("node_reparent: %i moves, the bounds, reach the service", async (n) => {
    const { service, call } = await harness({ reparentNodes: async () => receipt });
    const moves = Array.from({ length: n }, (_, i) => ({ nodeId: `n${i}`, parentId: "g" }));
    const result = await call("kalamo_node_reparent", { docId: "d", moves });
    expect(result.isError).toBeFalsy();
    expect(service.reparentNodes.mock.calls[0]?.[1]).toStrictEqual(moves);
  });

  it.each(writeOptions)(
    "mask_make: kind defaults to clip, with %s write options as given",
    async (_, write) => {
      const { service, call } = await harness({ makeMask: async () => receipt });
      await call("kalamo_mask_make", { docId: "d", clipNodeId: "c", contentIds: ["a"], ...write });
      expect(service.makeMask.mock.calls[0]).toStrictEqual([
        "d",
        { clipNodeId: "c", contentIds: ["a"], kind: "clip" },
        write,
      ]);
    },
  );

  it("mask_make: layerId alone reaches the service, kind defaulted", async () => {
    const { service, call } = await harness({ makeMask: async () => receipt });
    await call("kalamo_mask_make", { docId: "d", layerId: "l" });
    expect(service.makeMask.mock.calls[0]).toStrictEqual(["d", { layerId: "l", kind: "clip" }, {}]);
  });

  it.each(writeOptions)(
    "path_edit: the ops with their defaults, with %s write options as given",
    async (_, write) => {
      const out = { ...receipt, d: "M 0 0 L 5 5", subpaths: [] };
      const { service, call } = await harness({ pathEdit: async () => out });
      const ops = [{ op: "move_anchor", index: 1, to: [5, 5] }, { op: "reverse" }];
      const result = await call("kalamo_path_edit", { docId: "d", nodeId: "p", ops, ...write });
      expect(service.pathEdit.mock.calls[0]).toStrictEqual([
        "d",
        {
          nodeId: "p",
          ops: [{ op: "move_anchor", subpath: 0, index: 1, to: [5, 5] }, { op: "reverse" }],
        },
        write,
      ]);
      expect(result.structuredContent).toEqual(out);
    },
  );

  it.each(writeOptions)(
    "path_op: the operation arguments as given, with %s write options as given",
    async (_, write) => {
      const { service, call } = await harness({ pathOp: async () => receipt });
      const input = { nodeIds: ["r"], op: "simplify", tolerance: 0.5 };
      await call("kalamo_path_op", { docId: "d", ...input, ...write });
      expect(service.pathOp.mock.calls[0]).toStrictEqual(["d", PathOpInput.parse(input), write]);
    },
  );

  it.each(writeOptions)(
    "freehand_stroke: the fitted Ink as one path through createNodes, with %s write options as given",
    async (_, write) => {
      const { service, call } = await harness({ createNodes: async () => receipt });
      const points = [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
      ];
      const result = await call("kalamo_freehand_stroke", {
        docId: "d",
        parentId: "p",
        points,
        tool: "pencil",
        ...write,
      });
      expect(result.structuredContent).toEqual(receipt);
      expect(service.createNodes.mock.calls[0]).toStrictEqual([
        "d",
        [
          {
            type: "path",
            parentId: "p",
            d: "M 0 0 L 10 0",
            appearance: { fills: [], strokes: [{ color: "#000000" }] },
          },
        ],
        write,
      ]);
    },
  );

  it("freehand_stroke names its own parentId in an error", async () => {
    const { call } = await harness({
      createNodes: async () => {
        throw new KalamoError({
          code: "NODE_NOT_FOUND",
          message: "No Node with id p.",
          hint: "List ids.",
          path: "nodes[0].parentId",
        });
      },
    });
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const result = await call("kalamo_freehand_stroke", {
      docId: "d",
      parentId: "p",
      points,
      tool: "pencil",
    });
    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "")).toMatchObject({
      code: "NODE_NOT_FOUND",
      path: "parentId",
    });
  });

  it("mask_release", async () => {
    const { service, call } = await harness({ releaseMask: async () => receipt });
    await call("kalamo_mask_release", { docId: "d", nodeIds: ["g"], ...opts });
    expect(service.releaseMask).toHaveBeenCalledWith("d", ["g"], opts);
  });

  it("svg_import: fit defaults to false; no name or partial", async () => {
    const placed = { ...receipt, nodes: [] };
    const { service, call } = await harness({ place: async () => placed });
    const position = { x: 1, y: 2 };
    const result = await call("kalamo_svg_import", {
      docId: "d",
      svg: "<svg/>",
      parentId: "p",
      position,
      ...opts,
    });
    expect(result.structuredContent).toEqual(placed);
    expect(service.place).toHaveBeenCalledWith("d", {
      svg: "<svg/>",
      parentId: "p",
      position,
      fit: false,
      ...opts,
    });
  });

  it("image_place: asTemplate defaults to false; frame and the write options pass through; no partial", async () => {
    const { service, call } = await harness({ placeImage: async () => receipt });
    const frame = { x: 1, y: 2, width: 3, height: 4 };
    const src = "https://example.com/a.png";
    const result = await call("kalamo_image_place", {
      docId: "d",
      src,
      parentId: "p",
      frame,
      ...opts,
    });
    expect(result.structuredContent).toEqual(receipt);
    expect(service.placeImage).toHaveBeenCalledWith("d", {
      src,
      parentId: "p",
      frame,
      asTemplate: false,
      ...opts,
    });
  });

  it("doc_create and doc_open", async () => {
    const created = { docId: "d", defaultLayerId: "l", artboards: [], rev: 1 };
    const opened = { docId: "d", name: "Doc", artboards: [], rev: 1, nodes: [], warnings: [] };
    const { service, call } = await harness({
      create: async () => created,
      open: async () => opened,
    });
    await call("kalamo_doc_create", {
      name: "Doc",
      artboards: [{ x: 0, width: 10, height: 10 }],
      intent: "i",
    });
    expect(service.create).toHaveBeenCalledWith({
      name: "Doc",
      artboards: [expect.objectContaining({ x: 0, y: 0, width: 10, height: 10 })],
      intent: "i",
    });
    await call("kalamo_doc_open", { content: "{}", intent: "i" });
    expect(service.open).toHaveBeenCalledWith({ content: "{}", intent: "i" });
  });

  it("tx_begin, tx_commit and tx_rollback", async () => {
    const tx = { txId: "t", rev: 1 };
    const { service, call } = await harness({
      begin: async () => tx,
      commitTx: async () => receipt,
      rollback: async () => tx,
    });
    await call("kalamo_tx_begin", { docId: "d", label: "Label" });
    await call("kalamo_tx_begin", { docId: "d" });
    expect(service.begin.mock.calls).toEqual([
      ["d", "Label"],
      ["d", undefined],
    ]);
    await call("kalamo_tx_commit", { docId: "d", ...opts });
    expect(service.commitTx).toHaveBeenCalledWith("d", "t", { ifRev: 3, intent: "why" });
    await call("kalamo_tx_rollback", { docId: "d", txId: "t" });
    expect(service.rollback).toHaveBeenCalledWith("d", "t");
  });
});

const errorOf = (result: unknown) =>
  JSON.parse((result as { content: { text: string }[] }).content[0]?.text ?? "null");

describe("reads pass their filters and txId, and bad arguments never reach the service", () => {
  const view = { rev: 1, nodes: [] };

  it("node_get: concise by default", async () => {
    const { service, call } = await harness({ get: async () => view });
    await call("kalamo_node_get", { docId: "d", nodeIds: ["a"] });
    await call("kalamo_node_get", { docId: "d", nodeIds: ["a"], detail: "full", txId: "t" });
    expect(service.get.mock.calls).toEqual([
      ["d", ["a"], "concise", undefined],
      ["d", ["a"], "full", "t"],
    ]);
  });

  it("node_query: every filter, the cursor and the default limit, without docId or txId", async () => {
    const { service, call } = await harness({ query: async () => ({ ...view, nextCursor: null }) });
    const rect = { x: 0, y: 0, width: 1, height: 1 };
    const filters = {
      types: ["rect"],
      nameRegex: "^a",
      tags: ["t"],
      parentId: "p",
      withinRect: rect,
      intersectsRect: rect,
      cursor: "c",
    };
    await call("kalamo_node_query", { docId: "d", ...filters, txId: "t" });
    expect(service.query).toHaveBeenCalledWith("d", { ...filters, limit: 100 }, "t");
  });

  it("doc_outline: depth 2 with bounds by default; the options pass through", async () => {
    const { service, call } = await harness({ outline: async () => view });
    await call("kalamo_doc_outline", { docId: "d", txId: "t" });
    await call("kalamo_doc_outline", {
      docId: "d",
      rootId: "r",
      types: ["rect"],
      depth: 3,
      includeBounds: false,
    });
    expect(service.outline.mock.calls).toEqual([
      ["d", { depth: 2, includeBounds: true }, "t"],
      ["d", { rootId: "r", types: ["rect"], depth: 3, includeBounds: false }, undefined],
    ]);
  });

  it("doc_changes and doc_get_info", async () => {
    const { service, call } = await harness({
      changes: async () => ({ rev: 1, changes: [] }),
      info: async () => ({
        docId: "d",
        name: "D",
        artboards: [],
        nodeCount: 0,
        rev: 1,
        browsers: 0,
      }),
    });
    await call("kalamo_doc_changes", { docId: "d", sinceRev: 0 });
    expect(service.changes).toHaveBeenCalledWith("d", 0, 100);
    await call("kalamo_doc_get_info", { docId: "d" });
    expect(service.info).toHaveBeenCalledWith("d");
  });

  it.each([
    [
      "kalamo_doc_create",
      { name: "D", artboards: Array(1001).fill({ width: 1, height: 1 }) },
      "artboards",
    ],
    ["kalamo_node_get", { docId: "d", nodeIds: [] }, "nodeIds"],
    ["kalamo_node_query", { docId: "d", nameRegex: "(" }, "nameRegex"],
    ["kalamo_node_transform", { docId: "d", nodeIds: ["a"] }, undefined],
    [
      "kalamo_node_transform",
      { docId: "d", nodeIds: ["a"], matrix: [1, 0, 0, 1, 0, 0], rotate: 9 },
      undefined,
    ],
    [
      "kalamo_node_transform",
      { docId: "d", nodeIds: ["a"], matrix: [1, 1, 1, 1, 0, 0] },
      undefined,
    ],
    [
      "kalamo_node_create",
      { docId: "d", nodes: [{ type: "image", parentId: "p", file: "a.png", x: 0, y: 0 }] },
      "nodes[0].width",
    ],
    [
      "kalamo_node_create",
      { docId: "d", nodes: [{ type: "image", parentId: "p", x: 0, y: 0 }] },
      "nodes[0].src",
    ],
    ["kalamo_render", { docId: "d", scale: 5 }, "scale"],
    ["kalamo_export", { docId: "d", format: "pdf" }, "format"],
  ])("%s refuses %j by its published schema", async (name, args, path) => {
    const { call, called } = await harness();
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error).toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining(name) });
    expect(error.path).toBe(path);
    expect(error.hint).toEqual(expect.any(String));
    expect(called()).toEqual([]);
  });

  const entry = { nodeIds: ["a"], rotate: 1 };
  it.each([
    [
      "kalamo_node_transform",
      { partial: true, transforms: [entry], rotate: 5 },
      "rotate",
      "kalamo_node_transform takes transforms or rotate, not both.",
      "Put rotate inside each entry of transforms that needs it.",
    ],
    [
      "kalamo_node_transform",
      { partial: true, transforms: [entry], nodeIds: ["a"] },
      "nodeIds",
      "kalamo_node_transform takes transforms or nodeIds, not both.",
      "Put nodeIds inside each entry of transforms that needs it.",
    ],
    [
      "kalamo_node_transform",
      { partial: true, transforms: [entry], pivot: "top" },
      "pivot",
      "kalamo_node_transform takes transforms or pivot, not both.",
      "Put pivot inside each entry of transforms that needs it.",
    ],
    [
      "kalamo_node_transform",
      { partial: true, transforms: [] },
      "transforms",
      expect.any(String),
      "transforms must be at least 1 item.",
    ],
    [
      "kalamo_node_transform",
      { partial: true, transforms: [entry, { nodeIds: ["b"], rotat: 1 }] },
      "transforms[1].rotat",
      "kalamo_node_transform has no argument transforms[1].rotat.",
      expect.stringMatching(/^Did you mean rotate\? transforms\[1\] takes: nodeIds, /),
    ],
    [
      "kalamo_node_transform",
      {
        partial: true,
        transforms: [entry, { nodeIds: ["b"], matrix: [1, 0, 0, 1, 0, 0], rotate: 9 }],
      },
      "transforms[1]",
      expect.stringContaining("matrix replaces rotate"),
      expect.any(String),
    ],
    [
      "kalamo_node_transform",
      { partial: true, transforms: [entry, entry, { nodeIds: ["b"], matrix: [1, 0] }] },
      "transforms[2].matrix",
      expect.any(String),
      expect.any(String),
    ],
    [
      "kalamo_node_transform",
      { partial: true },
      "nodeIds",
      "kalamo_node_transform needs nodeIds.",
      "nodeIds is required.",
    ],
    [
      "kalamo_node_create",
      { nodes: [{ type: "text", parentId: "p", x: 0, y: 0, content: "Hi", alignment: "middle" }] },
      "nodes[0].alignment",
      expect.stringContaining("alignment"),
      expect.any(String),
    ],
    [
      "kalamo_mask_make",
      { clipNodeId: "c", contentIds: ["a"], layerId: "l" },
      "clipNodeId",
      "kalamo_mask_make takes layerId or clipNodeId, not both.",
      "Send layerId alone, or clipNodeId and contentIds without it.",
    ],
    [
      "kalamo_mask_make",
      { contentIds: ["a"], layerId: "l" },
      "contentIds",
      "kalamo_mask_make takes layerId or contentIds, not both.",
      "Send layerId alone, or clipNodeId and contentIds without it.",
    ],
    [
      "kalamo_mask_make",
      { clipNodeId: "c", layerId: "l" },
      "clipNodeId",
      "kalamo_mask_make takes layerId or clipNodeId, not both.",
      "Send layerId alone, or clipNodeId and contentIds without it.",
    ],
    [
      "kalamo_mask_make",
      { clipNodeId: "c" },
      undefined,
      "kalamo_mask_make: Invalid input",
      "The arguments matches none of the forms kalamo_mask_make takes; see its description.",
    ],
    [
      "kalamo_mask_make",
      {},
      undefined,
      "kalamo_mask_make: Invalid input",
      "The arguments matches none of the forms kalamo_mask_make takes; see its description.",
    ],
  ])("%s refuses %j as INVALID_INPUT at its path", async (name, args, path, message, hint) => {
    const { call, called } = await harness();
    const result = await call(name, { docId: "d", ...args });
    expect(errorOf(result)).toEqual({ code: "INVALID_INPUT", path, message, hint });
    expect(called()).toEqual([]);
  });

  it("names nameRegex when it does not compile", async () => {
    const { call } = await harness();
    const result = await call("kalamo_node_query", { docId: "d", nameRegex: "(" });
    expect(JSON.stringify(result.content)).toMatch(
      /nameRegex.*regular expression|regular expression.*nameRegex/,
    );
  });
});

describe("arguments are parsed strictly: a bad one is INVALID_INPUT and nothing runs (ADR-0050)", () => {
  it("refuses a filter it does not know instead of dropping it, naming the one meant", async () => {
    const { call, called } = await harness();
    const result = await call("kalamo_node_query", { docId: "d", name: "Cloud right" });
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: expect.any(String) }],
    });
    expect(errorOf(result)).toEqual({
      code: "INVALID_INPUT",
      message: "kalamo_node_query has no argument name.",
      hint: "Did you mean nameRegex? kalamo_node_query takes: docId, types, nameRegex, tags, parentId, withinRect, intersectsRect, limit, cursor, txId.",
      path: "name",
    });
    expect(called()).toEqual([]);
  });

  it("refuses a misspelled ifRev, so the conflict guard is never dropped", async () => {
    const { call, called } = await harness();
    const result = await call("kalamo_node_create", {
      docId: "d",
      nodes: [{ type: "layer", name: "L" }],
      ifrev: 3,
    });
    expect(errorOf(result)).toMatchObject({
      code: "INVALID_INPUT",
      path: "ifrev",
      hint: expect.stringMatching(/^Did you mean ifRev\? /),
    });
    expect(called()).toEqual([]);
  });

  it.each([
    [
      { type: "rect", parentId: "p", x: 0, y: 0, width: 1, height: 1, fill: "#FF0000" },
      "nodes[0].fill",
      "nodes[0] takes: type, x, y, width, height, radius, clientKey, name, tags, meta, parentId, appearance.",
    ],
    [
      {
        type: "group",
        parentId: "p",
        children: [
          { type: "ellipse", x: 0, y: 0, width: 1, height: 1 },
          {
            type: "rect",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            appearance: { fills: [{ colr: "red" }] },
          },
        ],
      },
      "nodes[0].children[1].appearance.fills[0].colr",
      "Did you mean color? nodes[0].children[1].appearance.fills[0] takes: type, color.",
    ],
  ])("points into nested arguments: %j", async (node, path, hint) => {
    const { call, called } = await harness();
    const result = await call("kalamo_node_create", { docId: "d", nodes: [node] });
    expect(errorOf(result)).toMatchObject({ code: "INVALID_INPUT", path, hint });
    expect(called()).toEqual([]);
  });

  it.each([
    ["kalamo_node_get", { nodeIds: ["a"] }, "docId", "docId is required."],
    ["kalamo_node_get", { docId: 3, nodeIds: ["a"] }, "docId", "Send a string as docId."],
    ["kalamo_node_get", { docId: "d", nodeIds: [] }, "nodeIds", "nodeIds must be at least 1 item."],
    ["kalamo_render", { docId: "d", scale: 5 }, "scale", "scale must be at most 4."],
    [
      "kalamo_export",
      { docId: "d", format: "pdf" },
      "format",
      "Send one of: svg, png, kalamo_json.",
    ],
    [
      "kalamo_node_create",
      { docId: "d", nodes: [{ type: "circle", parentId: "p" }] },
      "nodes[0].type",
      "Send one of: layer, rect, ellipse, line, polygon, star, spiral, path, text, image, group.",
    ],
    [
      "kalamo_node_create",
      {
        docId: "d",
        nodes: [{ type: "spiral", parentId: "p", cx: 0, cy: 0, radius: 9, revolution: 0.01 }],
      },
      "nodes[0].revolution",
      "nodes[0].revolution must be at least 0.05.",
    ],
    [
      "kalamo_node_update",
      { docId: "d", updates: [{ nodeId: "s", patch: { t0: 1 } }] },
      "updates[0].patch.t0",
      "updates[0].patch.t0 must be at most 0.999.",
    ],
    [
      "kalamo_render",
      { docId: "d", scope: { artboard: "a" } },
      "scope",
      "scope matches none of the forms kalamo_render takes; see its description.",
    ],
    [
      "kalamo_node_reparent",
      { docId: "d", moves: [{ nodeId: "a" }] },
      "moves[0].parentId",
      "moves[0].parentId is required.",
    ],
    [
      "kalamo_node_reparent",
      { docId: "d", moves: [{ nodeId: "a", parentId: "g", index: -1 }] },
      "moves[0].index",
      "moves[0].index must be at least 0.",
    ],
    [
      "kalamo_node_reorder",
      { docId: "d", nodeIds: ["a"] },
      "op",
      "Send one of: front, forward, backward, back.",
    ],
    [
      "kalamo_node_reorder",
      { docId: "d", nodeIds: ["a"], op: "top" },
      "op",
      "Send one of: front, forward, backward, back.",
    ],
    [
      "kalamo_node_reorder",
      { docId: "d", nodeIds: [], op: "front" },
      "nodeIds",
      "nodeIds must be at least 1 item.",
    ],
    [
      "kalamo_node_reorder",
      { docId: "d", nodeIds: ["a"], op: "front", parentId: "g" },
      "parentId",
      expect.any(String),
    ],
    [
      "kalamo_node_duplicate",
      { docId: "d", nodeIds: ["a"], count: 0 },
      "count",
      "count must be at least 1.",
    ],
    [
      "kalamo_node_duplicate",
      { docId: "d", nodeIds: ["a"], count: 101 },
      "count",
      "count must be at most 100.",
    ],
    [
      "kalamo_node_duplicate",
      { docId: "d", nodeIds: ["a"], count: 1.5 },
      "count",
      expect.any(String),
    ],
    [
      "kalamo_node_duplicate",
      { docId: "d", nodeIds: [] },
      "nodeIds",
      "nodeIds must be at least 1 item.",
    ],
    [
      "kalamo_node_duplicate",
      { docId: "d", nodeIds: ["a"], offset: { x: 1 } },
      "offset.y",
      "offset.y is required.",
    ],
    [
      "kalamo_node_duplicate",
      { docId: "d", nodeIds: ["a"], after: "b" },
      "after",
      expect.any(String),
    ],
    [
      "kalamo_node_duplicate",
      { docId: "d", nodeIds: ["a"], layerSuffix: " copy" },
      "layerSuffix",
      expect.any(String),
    ],
    [
      "kalamo_node_duplicate",
      { docId: "d", nodeIds: ["a"], partial: true },
      "partial",
      expect.any(String),
    ],
  ])("%s %j: %s, with a hint on what to send", async (name, args, path, hint) => {
    const { call, called } = await harness();
    expect(errorOf(await call(name, args))).toMatchObject({ code: "INVALID_INPUT", path, hint });
    expect(called()).toEqual([]);
  });

  it.each([
    [0, "moves must be at least 1 item."],
    [1001, "moves must be at most 1000 items."],
  ])("kalamo_node_reparent refuses %i moves: %s", async (n, hint) => {
    const { call, called } = await harness();
    const moves = Array(n).fill({ nodeId: "a", parentId: null });
    const result = await call("kalamo_node_reparent", { docId: "d", moves });
    expect(errorOf(result)).toMatchObject({ code: "INVALID_INPUT", path: "moves", hint });
    expect(called()).toEqual([]);
  });

  it("takes any keys in a Node's meta", async () => {
    const { service, call } = await harness({ createNodes: async () => receipt });
    const meta = { anything: 1, nested: { deep: [true] } };
    const result = await call("kalamo_node_create", {
      docId: "d",
      nodes: [{ type: "layer", name: "L", meta }],
    });
    expect(result.isError).toBeFalsy();
    expect(service.createNodes.mock.calls[0]?.[1]).toMatchObject([{ meta }]);
  });

  it("leaves a patch's own keys to core, which answers INVALID_PATCH, but not the objects in it", async () => {
    const { service, call } = await harness({ updateNodes: async () => receipt });
    const updates = [{ nodeId: "a", patch: { fil: "#FF0000" } }];
    await call("kalamo_node_update", { docId: "d", updates });
    expect(service.updateNodes.mock.calls[0]?.[1]).toEqual(updates);
    const nested = await call("kalamo_node_update", {
      docId: "d",
      updates: [{ nodeId: "a", patch: { appearance: { fils: [] } } }],
    });
    expect(errorOf(nested)).toMatchObject({
      code: "INVALID_INPUT",
      path: "updates[0].patch.appearance.fils",
      hint: expect.stringMatching(/^Did you mean fills\? /),
    });
    expect(service.updateNodes).toHaveBeenCalledTimes(1);
  });

  it("logs the refusal on the call's line with its code (§7.7)", async () => {
    const { call, log } = await harness();
    await call("kalamo_node_query", { docId: "d", name: "x" });
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({ tool: "kalamo_node_query", code: "INVALID_INPUT", nodes: 0 }),
    ]);
  });
});

describe("a tools/call without arguments is parsed as if it sent {} (#126)", () => {
  it("runs a tool with no required argument", async () => {
    const result = { documents: [] };
    const { client, service, call } = await harness({ list: async () => result });
    expect(await client.callTool({ name: "kalamo_doc_list" })).toEqual(
      await call("kalamo_doc_list"),
    );
    expect(service.list).toHaveBeenCalledTimes(2);
  });

  it.each(["kalamo_node_query", "kalamo_doc_delete", "kalamo_node_create"])(
    "%s: a missing docId is INVALID_INPUT, logged, and nothing runs",
    async (name) => {
      const { client, call, called, log } = await harness();
      const omitted = await client.callTool({ name });
      expect(errorOf(omitted)).toMatchObject({
        code: "INVALID_INPUT",
        path: "docId",
        hint: "docId is required.",
      });
      expect(omitted).toEqual(await call(name, {}));
      expect(called()).toEqual([]);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        tool: name,
        code: "INVALID_INPUT",
      });
    },
  );
});

it("advertises each tool's real input schema, refusing unknown keys but in meta and a patch (ADR-0050)", async () => {
  const { client } = await harness();
  const loose: string[] = [];
  const walk = (schema: unknown, at: string): void => {
    if (typeof schema !== "object" || schema === null) return;
    const s = schema as Record<string, unknown>;
    if (s.type === "object" && s.additionalProperties !== false) loose.push(at);
    for (const [k, v] of Object.entries(s)) walk(v, `${at}.${k}`);
  };
  for (const { name, inputSchema } of (await client.listTools()).tools) {
    expect(inputSchema.properties, name).toBeDefined();
    if (name !== "kalamo_doc_list") expect(inputSchema.required ?? [], name).not.toHaveLength(0);
    walk(inputSchema, name);
  }
  // A failing SDK upgrade advertises the catch-all object instead, which fails every tool here.
  expect(loose.filter((at) => !/\.properties\.(meta(\.anyOf\.\d)?|patch)$/.test(at))).toEqual([]);
  expect(loose).toContain("kalamo_node_update.properties.updates.items.properties.patch");
  expect(loose).toContain("kalamo_node_create.$defs.Node.oneOf.0.properties.meta");
});

describe("a KalamoError becomes the error result (F-MCP-15)", () => {
  it("carries every field of the error, and no structuredContent", async () => {
    const data = {
      code: "REV_CONFLICT" as const,
      message: "The Document is at rev 2.",
      hint: "Read kalamo_doc_changes, then retry with ifRev 2.",
      path: "ifRev",
      rev: 2,
      nodeIds: ["a"],
    };
    const { call } = await harness({
      createNodes: async () => {
        throw new KalamoError(data);
      },
    });
    const result = await call("kalamo_node_create", {
      docId: "d",
      nodes: [{ type: "layer", name: "L" }],
    });
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: JSON.stringify(data) }],
    });
    expect(errorOf(result)).toEqual(data);
  });

  it("does not dress another error as one", async () => {
    const { call } = await harness({
      info: async () => {
        throw new Error("boom");
      },
    });
    expect(await call("kalamo_doc_get_info", { docId: "d" })).toEqual({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    });
  });

  it.each([
    ["kalamo_render", {}],
    ["kalamo_export", { format: "png" }],
  ])("%s refuses a background that is not #RRGGBB[AA] before rendering", async (name, args) => {
    const { service, call } = await harness();
    const result = await call(name, { docId: "d", background: "red", ...args });
    expect(errorOf(result)).toMatchObject({
      code: "INVALID_COLOR",
      path: "background",
      hint: expect.stringContaining("#FF0000"),
    });
    expect(service.render).not.toHaveBeenCalled();
    expect(service.png).not.toHaveBeenCalled();
  });
});

describe("partial (F-MCP-16)", () => {
  const failed = [
    {
      index: 1,
      code: "NODE_NOT_FOUND",
      message: "No Node b.",
      hint: "List ids.",
      path: "updates[1].nodeId",
    },
  ];
  it.each([
    ["kalamo_node_create", "createNodes", { nodes: [{ type: "layer", name: "L" }] }],
    ["kalamo_node_update", "updateNodes", { updates: [{ nodeId: "a", patch: { name: "x" } }] }],
    ["kalamo_node_delete", "deleteNodes", { nodeIds: ["a"] }],
    ["kalamo_node_transform", "transformNodes", { nodeIds: ["a"], rotate: 1 }],
    ["kalamo_node_transform", "transformNodes", { transforms: [{ nodeIds: ["a"], rotate: 1 }] }],
    ["kalamo_node_reparent", "reparentNodes", { moves: [{ nodeId: "a", parentId: null }] }],
    ["kalamo_node_reorder", "reorderNodes", { nodeIds: ["a"], op: "front" }],
  ] as const)("%s passes partial and returns failed intact", async (name, method, args) => {
    const { service, call } = await harness({ [method]: async () => ({ ...receipt, failed }) });
    const result = await call(name, { docId: "d", ...args, partial: true });
    expect(result.structuredContent).toEqual({ ...receipt, failed });
    expect(service[method].mock.calls[0]?.at(-1)).toMatchObject({ partial: true });
  });
});

describe("render and export return an image, SVG text or file text", () => {
  const viewport = {
    docRect: { x: 0, y: 0, width: 2, height: 1 },
    pixelSize: { width: 4, height: 2 },
    scale: 2,
  };
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
  const image = {
    structuredContent: { viewport },
    content: [{ type: "image", mimeType: "image/png", data: "iVBORw==" }],
  };
  const scope = { artboardId: "A" };

  it("render: the PNG as image content with its viewport", async () => {
    const { service, call } = await harness({ render: async () => ({ png, viewport }) });
    const result = await call("kalamo_render", {
      docId: "d",
      scope,
      scale: 2,
      overlays: ["ids"],
      txId: "t",
      background: "#112233",
    });
    expect(result).toEqual(image);
    expect(service.render).toHaveBeenCalledWith("d", {
      scope,
      scale: 2,
      maxSize: 1600,
      overlays: ["ids"],
      txId: "t",
      background: "#112233",
    });
  });

  it("export png: the same image, without maxSize or overlays", async () => {
    const { service, call } = await harness({ png: async () => ({ png, viewport }) });
    const result = await call("kalamo_export", {
      docId: "d",
      format: "png",
      scope,
      scale: 2,
      txId: "t",
      background: "#112233",
    });
    expect(result).toEqual(image);
    expect(service.png).toHaveBeenCalledWith("d", {
      scope,
      txId: "t",
      background: "#112233",
      scale: 2,
    });
  });

  it("export svg: text content with docRect, and no scale", async () => {
    const docRect = { x: 0, y: 0, width: 2, height: 1 };
    const { service, call } = await harness({ svg: async () => ({ svg: "<svg/>", docRect }) });
    const result = await call("kalamo_export", { docId: "d", format: "svg", scope, scale: 3 });
    expect(result).toEqual({
      structuredContent: { docRect },
      content: [{ type: "text", text: "<svg/>" }],
    });
    expect(service.svg).toHaveBeenCalledWith("d", { scope, background: undefined });
  });

  it("export kalamo_json: the file text; scope, scale and background do not apply", async () => {
    const { service, call } = await harness({ file: async () => ({ text: "{}" }) });
    const result = await call("kalamo_export", {
      docId: "d",
      format: "kalamo_json",
      scope,
      scale: 2,
      background: "#112233",
      txId: "t",
    });
    expect(result).toEqual({ structuredContent: {}, content: [{ type: "text", text: "{}" }] });
    expect(service.file).toHaveBeenCalledWith("d", "t");
  });
});

it("publishes every tool with its annotations, input keys, outputSchema and description", async () => {
  const { client } = await harness();
  const tools = (await client.listTools()).tools as {
    name: string;
    annotations: object;
    inputSchema: object;
    outputSchema: object;
  }[];
  expect(tools.map((t) => t.name).sort()).toEqual([
    "kalamo_doc_changes",
    "kalamo_doc_create",
    "kalamo_doc_delete",
    "kalamo_doc_get_info",
    "kalamo_doc_list",
    "kalamo_doc_open",
    "kalamo_doc_outline",
    "kalamo_export",
    "kalamo_freehand_stroke",
    "kalamo_image_place",
    "kalamo_mask_make",
    "kalamo_mask_release",
    "kalamo_node_create",
    "kalamo_node_delete",
    "kalamo_node_duplicate",
    "kalamo_node_get",
    "kalamo_node_query",
    "kalamo_node_reorder",
    "kalamo_node_reparent",
    "kalamo_node_transform",
    "kalamo_node_update",
    "kalamo_path_edit",
    "kalamo_path_op",
    "kalamo_render",
    "kalamo_svg_import",
    "kalamo_tx_begin",
    "kalamo_tx_commit",
    "kalamo_tx_rollback",
  ]);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const inputKeys = (name: string) => {
    const tool = byName[name];
    return tool ? Object.keys((tool.inputSchema as { properties: object }).properties) : [];
  };
  for (const [name, destructive] of [
    ["kalamo_node_create", false],
    ["kalamo_node_update", true],
    ["kalamo_node_delete", true],
    ["kalamo_node_transform", false],
    ["kalamo_node_reparent", false],
    ["kalamo_node_reorder", false],
  ] as const) {
    expect(byName[name]?.annotations).toMatchObject({ destructiveHint: destructive });
    expect(inputKeys(name)).toEqual(
      expect.arrayContaining(["docId", "intent", "txId", "ifRev", "partial"]),
    );
  }
  expect(inputKeys("kalamo_doc_create")).toContain("intent");
  expect(inputKeys("kalamo_svg_import").sort()).toEqual(
    ["docId", "fit", "ifRev", "intent", "parentId", "position", "svg", "txId"].sort(),
  );
  expect(byName.kalamo_svg_import?.annotations).toMatchObject({ destructiveHint: false });
  expect(inputKeys("kalamo_node_duplicate").sort()).toEqual(
    ["count", "docId", "ifRev", "intent", "nodeIds", "offset", "targetParentId", "txId"].sort(),
  );
  expect(byName.kalamo_node_duplicate?.annotations).toMatchObject({ destructiveHint: false });
  expect(inputKeys("kalamo_image_place").sort()).toEqual(
    ["asTemplate", "docId", "frame", "ifRev", "intent", "parentId", "src", "txId"].sort(),
  );
  for (const name of [
    "kalamo_freehand_stroke",
    "kalamo_mask_make",
    "kalamo_mask_release",
    "kalamo_path_edit",
    "kalamo_path_op",
  ]) {
    expect(inputKeys(name)).toEqual(expect.arrayContaining(["docId", "intent", "txId", "ifRev"]));
    expect(inputKeys(name)).not.toContain("partial");
  }
  for (const name of [
    "kalamo_node_get",
    "kalamo_node_query",
    "kalamo_doc_outline",
    "kalamo_render",
    "kalamo_export",
  ]) {
    expect(inputKeys(name)).toContain("txId");
  }
  expect(inputKeys("kalamo_tx_commit")).toEqual(
    expect.arrayContaining(["docId", "txId", "ifRev", "intent"]),
  );
  expect(byName.kalamo_doc_changes?.annotations).toMatchObject({ readOnlyHint: true });
  expect(byName.kalamo_doc_get_info?.annotations).toMatchObject({ readOnlyHint: true });
  expect(byName.kalamo_doc_list?.annotations).toMatchObject({ readOnlyHint: true });
  expect(byName.kalamo_tx_rollback?.annotations).toMatchObject({ destructiveHint: true });
  expect(byName.kalamo_doc_delete?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
  expect(byName.kalamo_tx_commit?.annotations).toMatchObject({ destructiveHint: false });
  expect(JSON.stringify(tools)).not.toContain("no effect yet");
  // Descriptions point at the Skill document instead of repeating its conventions.
  const described = (name: string) => (byName[name] as { description?: string })?.description;
  for (const name of ["kalamo_doc_create", "kalamo_node_create", "kalamo_node_update"]) {
    expect(described(name)).toContain("skill://kalamo/drawing-conventions");
  }
  expect(described("kalamo_node_create")).not.toContain("origin top-left");
  expect(described("kalamo_node_transform")).toContain("transforms: [{nodeIds, rotate, ...}, ...]");
  expect(described("kalamo_node_delete")).toContain("LAST_LAYER");
  expect(described("kalamo_tx_commit")).toContain("no top-level Layer left");
  expect(described("kalamo_node_reparent")).toContain("stops clipping");
  expect(described("kalamo_node_reparent")).toContain("one Transaction");
  expect(described("kalamo_node_update")).toContain("kalamo_node_reparent");
  expect(described("kalamo_node_update")).toContain("kalamo_node_reorder");
  expect(described("kalamo_node_reorder")).toContain("keeps clipping");
  expect(described("kalamo_node_reorder")).toContain("one undo step");
  expect(byName.kalamo_node_reorder?.annotations).toMatchObject({ idempotentHint: false });
  expect(byName.kalamo_node_reparent?.annotations).toMatchObject({ idempotentHint: true });
  expect(described("kalamo_node_create")).toContain("text {");
  expect(described("kalamo_node_create")).toContain("TEXT_OVERFLOW");
  expect(described("kalamo_node_create")).toContain("MISSING_GLYPHS");
  expect(described("kalamo_node_update")).toContain("leading");
  expect(described("kalamo_node_create")).toContain("Bold Italic");
  expect(described("kalamo_node_update")).toContain("fontStyle");
  for (const word of ["tracking", "ranges"])
    expect(described("kalamo_node_create")).toContain(word);
  expect(described("kalamo_node_update")).toContain("ranges");
  expect(described("kalamo_node_update")).toContain("clears");
  expect(described("kalamo_node_create")).toContain("image {");
  expect(described("kalamo_node_create")).toContain("missing link");
  expect(JSON.stringify(byName.kalamo_node_create?.inputSchema)).toContain(
    "at most 2048 characters",
  );
  expect(described("kalamo_node_update")).toContain("preserveAspectRatio");
  // Relink and Embed (ADR-0042).
  expect(described("kalamo_node_update")).not.toContain("src is read-only");
  for (const word of ["Relink", "file: null", "Embed", "INVALID_IMAGE"]) {
    expect(described("kalamo_node_update")).toContain(word);
  }
  for (const key of ["src", "file"]) {
    expect(JSON.stringify(byName.kalamo_node_update?.inputSchema)).toContain(`"${key}"`);
  }
  for (const param of [
    "angle",
    "twist",
    "rounded",
    "randomized",
    "startAngle",
    "endAngle",
    "arcType",
  ]) {
    expect(described("kalamo_node_create")).toContain(param);
    expect(JSON.stringify(byName.kalamo_node_update?.inputSchema)).toContain(`"${param}"`);
  }
  for (const word of ["gradient", "stops", "radial", "aspectRatio", "focus", "midpoint"]) {
    expect(described("kalamo_node_create")).toContain(word);
    expect(JSON.stringify(byName.kalamo_node_update?.inputSchema)).toContain(`"${word}"`);
  }
  expect(described("kalamo_node_update")).toContain("gradient");
  for (const tool of ["kalamo_doc_open", "kalamo_svg_import"]) {
    expect(described(tool)).toContain("IMAGE_LINK_MISSING");
    expect(described(tool)).not.toContain("LINKED_IMAGE_DROPPED");
  }
  expect(described("kalamo_doc_open")).not.toMatch(/\(gradients/);
  for (const t of tools) {
    expect(t.annotations, t.name).toEqual({
      readOnlyHint: expect.any(Boolean),
      destructiveHint: expect.any(Boolean),
      idempotentHint: expect.any(Boolean),
      // Only image_place reaches outside the service: it fetches a URL (ADR-0027).
      openWorldHint: t.name === "kalamo_image_place",
    });
    expect(t.outputSchema, t.name).toMatchObject({ type: "object" });
  }
  // Core validates colours, but Agents still read the pattern from the published schema (§6.5).
  const nodeCreate = tools.find((t) => t.name === "kalamo_node_create");
  expect(JSON.stringify(nodeCreate?.inputSchema)).toContain(
    JSON.stringify({ type: "string", pattern: COLOR_PATTERN }).slice(1, -1),
  );
});

it("publishes appearance with contents on layer and group in node_create and node_update (ADR-0043)", async () => {
  const { client } = await harness();
  const tools = (await client.listTools()).tools;
  const create = tools.find((t) => t.name === "kalamo_node_create");
  if (!create) throw new Error("setup");
  type Schema = { $ref?: string; const?: string; properties?: Record<string, Schema> };
  const defs = create.inputSchema.$defs as Record<string, Schema & { oneOf: Schema[] }>;
  const deref = (s?: Schema) => (s?.$ref ? defs[s.$ref.replace("#/$defs/", "")] : s);
  expect(create.inputSchema.properties?.nodes).toMatchObject({ items: { $ref: "#/$defs/Node" } });
  for (const type of ["layer", "group"]) {
    const v = defs.Node?.oneOf.find((o) => o.properties?.type?.const === type);
    expect(deref(v?.properties?.appearance)?.properties, type).toHaveProperty("contents");
    expect(create.description).toContain(`${type} {`);
  }
  expect(create.description).toContain("contents");
  const update = tools.find((t) => t.name === "kalamo_node_update");
  expect(JSON.stringify(update?.inputSchema)).toContain('"contents"');
  expect(update?.description).toContain("appearance: null removes it");
});

it("keeps the tool definitions an Agent reads every turn within budget (#229)", async () => {
  const { client } = await harness();
  const { tools } = await client.listTools();
  // What a client puts in the model's context for each tool; outputSchema stays with the client.
  const sizes = Object.fromEntries(
    tools.map((t) => [
      t.name,
      Buffer.byteLength(
        JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }),
      ),
    ]),
  );
  // Raise a budget only on purpose: every byte here is paid on every turn of every Agent.
  expect(Object.values(sizes).reduce((a, b) => a + b)).toBeLessThanOrEqual(112_000);
  for (const [name, size] of Object.entries(sizes)) expect(size, name).toBeLessThanOrEqual(28_000);
  // A shared definition is written once per tool, not once per use: a Color Stop's offset sits in
  // every Fill and Stroke of every type, and a Group's children are Nodes again.
  const create = JSON.stringify(tools.find((t) => t.name === "kalamo_node_create"));
  expect(create.split("0 at the gradient's start, 1 at its end.")).toHaveLength(2);
  expect(create).toMatch(/"children":\{[^}]*"items":\{"\$ref":"#\/\$defs\/Node"\}/);
});

it("serves skill://kalamo/drawing-conventions and points at it in the instructions", async () => {
  const uri = "skill://kalamo/drawing-conventions";
  const { client } = await harness();
  expect(client.getInstructions()).toContain(uri);
  expect((await client.listResources()).resources).toContainEqual(
    expect.objectContaining({ uri, mimeType: "text/markdown" }),
  );
  const [doc] = (await client.readResource({ uri })).contents;
  expect(doc).toMatchObject({ uri, mimeType: "text/markdown" });
  const text = (doc as { text: string }).text;
  for (const fact of [
    "#RRGGBB",
    "y down",
    "parentId",
    "ifRev",
    "kalamo_doc_changes",
    "kalamo_json",
    "kalamo_doc_open",
    "INVALID_DOCUMENT",
    "SVG",
    "FONT_MISSING",
    "MISSING_GLYPHS",
    "LIMIT_EXCEEDED",
    "## Images",
    "INVALID_IMAGE",
    '"type": "gradient"',
    "aspectRatio",
    "kalamo_image_place",
    "Template Layer",
    "LAST_LAYER",
    // What kalamo_path_op and kalamo_node_update leave to this document (#229).
    "## Path operations",
    "CONVERTED_TO_PATH",
    "TEXT_DISCARDED",
    "2048 characters",
  ]) {
    expect(text).toContain(fact);
  }
  // Drift guard: the document names only tools that exist; kalamo_json is an export format.
  const tools = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const [name] of text.matchAll(/kalamo_(?!json\b)[a-z_]+/g)) expect(tools).toContain(name);
  await expect(client.readResource({ uri: "skill://kalamo/nope" })).rejects.toMatchObject({
    code: -32602,
  });
});

it("logs one line per call: Actor, tool, duration, node count, error code and rev (§7.7)", async () => {
  const { call, log } = await harness(
    {
      createNodes: async () => ({ ...receipt, createdIds: ["n"] }),
      outline: async () => {
        throw new KalamoError({ code: "DOC_NOT_FOUND", message: "No Document.", hint: "List." });
      },
    },
    "agent-b",
  );
  await call("kalamo_node_create", { docId: "d", nodes: [{ type: "layer", name: "L" }] });
  await call("kalamo_doc_outline", { docId: "d" });
  expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
    {
      actor: "agent-b",
      tool: "kalamo_node_create",
      ms: expect.any(Number),
      nodes: 1,
      code: null,
      rev: 2,
    },
    {
      actor: "agent-b",
      tool: "kalamo_doc_outline",
      ms: expect.any(Number),
      nodes: 0,
      code: "DOC_NOT_FOUND",
      rev: null,
    },
  ]);
});

it("names every tool kalamo_ and knows the former name's tools and format as nothing (ADR-0069)", async () => {
  const { client, call } = await harness();
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toHaveLength(28);
  expect(names.filter((n) => !n.startsWith("kalamo_") || n.includes(LEGACY_NAME))).toEqual([]);

  const failure = async (name: string) =>
    JSON.stringify(await call(name, { docId: "d" }).catch((e: Error) => e.message)).replace(
      name,
      "<tool>",
    );
  expect(await failure(`${LEGACY_NAME}_doc_get_info`)).toBe(await failure("unknown_doc_get_info"));

  const result = await call("kalamo_export", { docId: "d", format: `${LEGACY_NAME}_json` });
  expect(errorOf(result)).toMatchObject({
    code: "INVALID_INPUT",
    path: "format",
    hint: "Send one of: svg, png, kalamo_json.",
  });
});
