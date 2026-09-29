import { COLOR_PATTERN, KalamoError, PathOpInput } from "@kalamo/core";
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
  expect(await call("zibel_doc_list")).toEqual({
    structuredContent: result,
    content: [{ type: "text", text: JSON.stringify(result) }],
  });
  expect(service.list).toHaveBeenCalledWith();
});

it("doc_delete deletes by docId and returns the receipt", async () => {
  const { service, call } = await harness({
    delete: async (docId) => ({ docId, deleted: true }),
  });
  expect((await call("zibel_doc_delete", { docId: "d" })).structuredContent).toEqual({
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
    const result = await call("zibel_node_create", { docId: "d", nodes, ...opts });
    expect(result.structuredContent).toEqual(receipt);
    const [docId, sent, options] = service.createNodes.mock.calls[0] ?? [];
    expect(docId).toBe("d");
    expect(options).toEqual({ ...opts, partial: false });
    expect(sent).toMatchObject([
      { type: "layer", parentId: null },
      { type: "group", children: [{ type: "line" }] },
      { type: "rect", radius: 0 },
      { type: "ellipse", startAngle: 0, endAngle: 360, arcType: "slice" },
      { type: "ellipse", startAngle: 300, endAngle: 60, arcType: "chord" },
      { type: "polygon", angle: 0, rounded: 0, randomized: 0 },
      { type: "star", angle: 0, twist: 10, rounded: 0.3, randomized: 0.1 },
      { type: "path", fillRule: "nonzero" },
      { type: "text", kind: "point", fontFamily: "Source Sans 3", fontSize: 12 },
      { type: "text", kind: "area", width: 50, height: 20, content: "a\nb", fontSize: 12 },
      { type: "image", src: "data:image/png;base64,AAAA", preserveAspectRatio: "none" },
    ]);
    expect(sent?.[10]).not.toHaveProperty("appearance");
    await call("zibel_node_create", { docId: "d", nodes: [nodes[2]] });
    expect(service.createNodes.mock.calls[1]?.[2]).toEqual({ partial: false });
  });

  it("node_create: a linked image arrives with file, and src only when sent (ADR-0042)", async () => {
    const { service, call } = await harness({ createNodes: async () => receipt });
    const frame = { parentId: "p", x: 0, y: 0, width: 4, height: 2 };
    await call("zibel_node_create", {
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
    await call("zibel_node_update", { docId: "d", updates, ...opts });
    const [docId, sent, options] = service.updateNodes.mock.calls[0] ?? [];
    expect([docId, options]).toEqual(["d", { ...opts, partial: false }]);
    // Strict: a default filled in as an undefined key would still reach the Durable Object.
    expect(sent).toStrictEqual(updates);
  });

  it("node_delete", async () => {
    const { service, call } = await harness({ deleteNodes: async () => receipt });
    await call("zibel_node_delete", { docId: "d", nodeIds: ["a", "b"], ...opts });
    expect(service.deleteNodes).toHaveBeenCalledWith("d", ["a", "b"], {
      ...opts,
      partial: false,
    });
  });

  it("node_transform: the transform gets none of the write options", async () => {
    const { service, call } = await harness({ transformNodes: async () => receipt });
    await call("zibel_node_transform", {
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

  it.each(writeOptions)(
    "mask_make: kind defaults to clip, with %s write options as given",
    async (_, write) => {
      const { service, call } = await harness({ makeMask: async () => receipt });
      await call("zibel_mask_make", { docId: "d", clipNodeId: "c", contentIds: ["a"], ...write });
      expect(service.makeMask.mock.calls[0]).toStrictEqual([
        "d",
        { clipNodeId: "c", contentIds: ["a"], kind: "clip" },
        write,
      ]);
    },
  );

  it.each(writeOptions)(
    "path_edit: the ops with their defaults, with %s write options as given",
    async (_, write) => {
      const out = { ...receipt, d: "M 0 0 L 5 5", subpaths: [] };
      const { service, call } = await harness({ pathEdit: async () => out });
      const ops = [{ op: "move_anchor", index: 1, to: [5, 5] }, { op: "reverse" }];
      const result = await call("zibel_path_edit", { docId: "d", nodeId: "p", ops, ...write });
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
      await call("zibel_path_op", { docId: "d", ...input, ...write });
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
      const result = await call("zibel_freehand_stroke", {
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
    const result = await call("zibel_freehand_stroke", {
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
    await call("zibel_mask_release", { docId: "d", nodeIds: ["g"], ...opts });
    expect(service.releaseMask).toHaveBeenCalledWith("d", ["g"], opts);
  });

  it("svg_import: fit defaults to false; no name or partial", async () => {
    const placed = { ...receipt, nodes: [] };
    const { service, call } = await harness({ place: async () => placed });
    const position = { x: 1, y: 2 };
    const result = await call("zibel_svg_import", {
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
    const result = await call("zibel_image_place", {
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
    await call("zibel_doc_create", {
      name: "Doc",
      artboards: [{ x: 0, width: 10, height: 10 }],
      intent: "i",
    });
    expect(service.create).toHaveBeenCalledWith({
      name: "Doc",
      artboards: [expect.objectContaining({ x: 0, y: 0, width: 10, height: 10 })],
      intent: "i",
    });
    await call("zibel_doc_open", { content: "{}", intent: "i" });
    expect(service.open).toHaveBeenCalledWith({ content: "{}", intent: "i" });
  });

  it("tx_begin, tx_commit and tx_rollback", async () => {
    const tx = { txId: "t", rev: 1 };
    const { service, call } = await harness({
      begin: async () => tx,
      commitTx: async () => receipt,
      rollback: async () => tx,
    });
    await call("zibel_tx_begin", { docId: "d", label: "Label" });
    await call("zibel_tx_begin", { docId: "d" });
    expect(service.begin.mock.calls).toEqual([
      ["d", "Label"],
      ["d", undefined],
    ]);
    await call("zibel_tx_commit", { docId: "d", ...opts });
    expect(service.commitTx).toHaveBeenCalledWith("d", "t", { ifRev: 3, intent: "why" });
    await call("zibel_tx_rollback", { docId: "d", txId: "t" });
    expect(service.rollback).toHaveBeenCalledWith("d", "t");
  });
});

const errorOf = (result: unknown) =>
  JSON.parse((result as { content: { text: string }[] }).content[0]?.text ?? "null");

describe("reads pass their filters and txId, and bad arguments never reach the service", () => {
  const view = { rev: 1, nodes: [] };

  it("node_get: concise by default", async () => {
    const { service, call } = await harness({ get: async () => view });
    await call("zibel_node_get", { docId: "d", nodeIds: ["a"] });
    await call("zibel_node_get", { docId: "d", nodeIds: ["a"], detail: "full", txId: "t" });
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
    await call("zibel_node_query", { docId: "d", ...filters, txId: "t" });
    expect(service.query).toHaveBeenCalledWith("d", { ...filters, limit: 100 }, "t");
  });

  it("doc_outline: depth 2 with bounds by default; the options pass through", async () => {
    const { service, call } = await harness({ outline: async () => view });
    await call("zibel_doc_outline", { docId: "d", txId: "t" });
    await call("zibel_doc_outline", {
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
    await call("zibel_doc_changes", { docId: "d", sinceRev: 0 });
    expect(service.changes).toHaveBeenCalledWith("d", 0, 100);
    await call("zibel_doc_get_info", { docId: "d" });
    expect(service.info).toHaveBeenCalledWith("d");
  });

  it.each([
    [
      "zibel_doc_create",
      { name: "D", artboards: Array(1001).fill({ width: 1, height: 1 }) },
      "artboards",
    ],
    ["zibel_node_get", { docId: "d", nodeIds: [] }, "nodeIds"],
    ["zibel_node_query", { docId: "d", nameRegex: "(" }, "nameRegex"],
    ["zibel_node_transform", { docId: "d", nodeIds: ["a"] }, undefined],
    [
      "zibel_node_transform",
      { docId: "d", nodeIds: ["a"], matrix: [1, 0, 0, 1, 0, 0], rotate: 9 },
      undefined,
    ],
    ["zibel_node_transform", { docId: "d", nodeIds: ["a"], matrix: [1, 1, 1, 1, 0, 0] }, undefined],
    [
      "zibel_node_create",
      { docId: "d", nodes: [{ type: "image", parentId: "p", file: "a.png", x: 0, y: 0 }] },
      "nodes[0].width",
    ],
    [
      "zibel_node_create",
      { docId: "d", nodes: [{ type: "image", parentId: "p", x: 0, y: 0 }] },
      "nodes[0].src",
    ],
    ["zibel_render", { docId: "d", scale: 5 }, "scale"],
    ["zibel_export", { docId: "d", format: "pdf" }, "format"],
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

  it("names nameRegex when it does not compile", async () => {
    const { call } = await harness();
    const result = await call("zibel_node_query", { docId: "d", nameRegex: "(" });
    expect(JSON.stringify(result.content)).toMatch(
      /nameRegex.*regular expression|regular expression.*nameRegex/,
    );
  });
});

describe("arguments are parsed strictly: a bad one is INVALID_INPUT and nothing runs (ADR-0050)", () => {
  it("refuses a filter it does not know instead of dropping it, naming the one meant", async () => {
    const { call, called } = await harness();
    const result = await call("zibel_node_query", { docId: "d", name: "Cloud right" });
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: expect.any(String) }],
    });
    expect(errorOf(result)).toEqual({
      code: "INVALID_INPUT",
      message: "zibel_node_query has no argument name.",
      hint: "Did you mean nameRegex? zibel_node_query takes: docId, types, nameRegex, tags, parentId, withinRect, intersectsRect, limit, cursor, txId.",
      path: "name",
    });
    expect(called()).toEqual([]);
  });

  it("refuses a misspelled ifRev, so the conflict guard is never dropped", async () => {
    const { call, called } = await harness();
    const result = await call("zibel_node_create", {
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
      "nodes[0] takes: type, x, y, width, height, radius, clientKey, name, tags, meta, appearance, parentId.",
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
    const result = await call("zibel_node_create", { docId: "d", nodes: [node] });
    expect(errorOf(result)).toMatchObject({ code: "INVALID_INPUT", path, hint });
    expect(called()).toEqual([]);
  });

  it.each([
    ["zibel_node_get", { nodeIds: ["a"] }, "docId", "docId is required."],
    ["zibel_node_get", { docId: 3, nodeIds: ["a"] }, "docId", "Send a string as docId."],
    ["zibel_node_get", { docId: "d", nodeIds: [] }, "nodeIds", "nodeIds must be at least 1 item."],
    ["zibel_render", { docId: "d", scale: 5 }, "scale", "scale must be at most 4."],
    ["zibel_export", { docId: "d", format: "pdf" }, "format", "Send one of: svg, png, zibel_json."],
    [
      "zibel_node_create",
      { docId: "d", nodes: [{ type: "circle", parentId: "p" }] },
      "nodes[0].type",
      "Send one of: layer, rect, ellipse, line, polygon, star, spiral, path, text, image, group.",
    ],
    [
      "zibel_node_create",
      {
        docId: "d",
        nodes: [{ type: "spiral", parentId: "p", cx: 0, cy: 0, radius: 9, revolution: 0.01 }],
      },
      "nodes[0].revolution",
      "nodes[0].revolution must be at least 0.05.",
    ],
    [
      "zibel_render",
      { docId: "d", scope: { artboard: "a" } },
      "scope",
      "scope matches none of the forms zibel_render takes; see its description.",
    ],
  ])("%s %j: %s, with a hint on what to send", async (name, args, path, hint) => {
    const { call, called } = await harness();
    expect(errorOf(await call(name, args))).toMatchObject({ code: "INVALID_INPUT", path, hint });
    expect(called()).toEqual([]);
  });

  it("takes any keys in a Node's meta", async () => {
    const { service, call } = await harness({ createNodes: async () => receipt });
    const meta = { anything: 1, nested: { deep: [true] } };
    const result = await call("zibel_node_create", {
      docId: "d",
      nodes: [{ type: "layer", name: "L", meta }],
    });
    expect(result.isError).toBeFalsy();
    expect(service.createNodes.mock.calls[0]?.[1]).toMatchObject([{ meta }]);
  });

  it("leaves a patch's own keys to core, which answers INVALID_PATCH, but not the objects in it", async () => {
    const { service, call } = await harness({ updateNodes: async () => receipt });
    const updates = [{ nodeId: "a", patch: { fil: "#FF0000" } }];
    await call("zibel_node_update", { docId: "d", updates });
    expect(service.updateNodes.mock.calls[0]?.[1]).toEqual(updates);
    const nested = await call("zibel_node_update", {
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
    await call("zibel_node_query", { docId: "d", name: "x" });
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({ tool: "zibel_node_query", code: "INVALID_INPUT", nodes: 0 }),
    ]);
  });
});

describe("a tools/call without arguments is parsed as if it sent {} (#126)", () => {
  it("runs a tool with no required argument", async () => {
    const result = { documents: [] };
    const { client, service, call } = await harness({ list: async () => result });
    expect(await client.callTool({ name: "zibel_doc_list" })).toEqual(await call("zibel_doc_list"));
    expect(service.list).toHaveBeenCalledTimes(2);
  });

  it.each(["zibel_node_query", "zibel_doc_delete", "zibel_node_create"])(
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
    if (name !== "zibel_doc_list") expect(inputSchema.required ?? [], name).not.toHaveLength(0);
    walk(inputSchema, name);
  }
  // A failing SDK upgrade advertises the catch-all object instead, which fails every tool here.
  expect(loose.filter((at) => !/\.properties\.(meta(\.anyOf\.\d)?|patch)$/.test(at))).toEqual([]);
  expect(loose).toContain("zibel_node_update.properties.updates.items.properties.patch");
  expect(loose).toContain("zibel_node_create.properties.nodes.items.oneOf.0.properties.meta");
});

describe("a KalamoError becomes the error result (F-MCP-15)", () => {
  it("carries every field of the error, and no structuredContent", async () => {
    const data = {
      code: "REV_CONFLICT" as const,
      message: "The Document is at rev 2.",
      hint: "Read zibel_doc_changes, then retry with ifRev 2.",
      path: "ifRev",
      rev: 2,
      nodeIds: ["a"],
    };
    const { call } = await harness({
      createNodes: async () => {
        throw new KalamoError(data);
      },
    });
    const result = await call("zibel_node_create", {
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
    expect(await call("zibel_doc_get_info", { docId: "d" })).toEqual({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    });
  });

  it.each([
    ["zibel_render", {}],
    ["zibel_export", { format: "png" }],
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
    ["zibel_node_create", "createNodes", { nodes: [{ type: "layer", name: "L" }] }],
    ["zibel_node_update", "updateNodes", { updates: [{ nodeId: "a", patch: { name: "x" } }] }],
    ["zibel_node_delete", "deleteNodes", { nodeIds: ["a"] }],
    ["zibel_node_transform", "transformNodes", { nodeIds: ["a"], rotate: 1 }],
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
    const result = await call("zibel_render", {
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
    const result = await call("zibel_export", {
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
    const result = await call("zibel_export", { docId: "d", format: "svg", scope, scale: 3 });
    expect(result).toEqual({
      structuredContent: { docRect },
      content: [{ type: "text", text: "<svg/>" }],
    });
    expect(service.svg).toHaveBeenCalledWith("d", { scope, background: undefined });
  });

  it("export zibel_json: the file text; scope, scale and background do not apply", async () => {
    const { service, call } = await harness({ file: async () => ({ text: "{}" }) });
    const result = await call("zibel_export", {
      docId: "d",
      format: "zibel_json",
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
    "zibel_doc_changes",
    "zibel_doc_create",
    "zibel_doc_delete",
    "zibel_doc_get_info",
    "zibel_doc_list",
    "zibel_doc_open",
    "zibel_doc_outline",
    "zibel_export",
    "zibel_freehand_stroke",
    "zibel_image_place",
    "zibel_mask_make",
    "zibel_mask_release",
    "zibel_node_create",
    "zibel_node_delete",
    "zibel_node_get",
    "zibel_node_query",
    "zibel_node_transform",
    "zibel_node_update",
    "zibel_path_edit",
    "zibel_path_op",
    "zibel_render",
    "zibel_svg_import",
    "zibel_tx_begin",
    "zibel_tx_commit",
    "zibel_tx_rollback",
  ]);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const inputKeys = (name: string) => {
    const tool = byName[name];
    return tool ? Object.keys((tool.inputSchema as { properties: object }).properties) : [];
  };
  for (const [name, destructive] of [
    ["zibel_node_create", false],
    ["zibel_node_update", true],
    ["zibel_node_delete", true],
    ["zibel_node_transform", false],
  ] as const) {
    expect(byName[name]?.annotations).toMatchObject({ destructiveHint: destructive });
    expect(inputKeys(name)).toEqual(
      expect.arrayContaining(["docId", "intent", "txId", "ifRev", "partial"]),
    );
  }
  expect(inputKeys("zibel_doc_create")).toContain("intent");
  expect(inputKeys("zibel_svg_import").sort()).toEqual(
    ["docId", "fit", "ifRev", "intent", "parentId", "position", "svg", "txId"].sort(),
  );
  expect(byName.zibel_svg_import?.annotations).toMatchObject({ destructiveHint: false });
  expect(inputKeys("zibel_image_place").sort()).toEqual(
    ["asTemplate", "docId", "frame", "ifRev", "intent", "parentId", "src", "txId"].sort(),
  );
  for (const name of [
    "zibel_freehand_stroke",
    "zibel_mask_make",
    "zibel_mask_release",
    "zibel_path_edit",
    "zibel_path_op",
  ]) {
    expect(inputKeys(name)).toEqual(expect.arrayContaining(["docId", "intent", "txId", "ifRev"]));
    expect(inputKeys(name)).not.toContain("partial");
  }
  for (const name of [
    "zibel_node_get",
    "zibel_node_query",
    "zibel_doc_outline",
    "zibel_render",
    "zibel_export",
  ]) {
    expect(inputKeys(name)).toContain("txId");
  }
  expect(inputKeys("zibel_tx_commit")).toEqual(
    expect.arrayContaining(["docId", "txId", "ifRev", "intent"]),
  );
  expect(byName.zibel_doc_changes?.annotations).toMatchObject({ readOnlyHint: true });
  expect(byName.zibel_doc_get_info?.annotations).toMatchObject({ readOnlyHint: true });
  expect(byName.zibel_doc_list?.annotations).toMatchObject({ readOnlyHint: true });
  expect(byName.zibel_tx_rollback?.annotations).toMatchObject({ destructiveHint: true });
  expect(byName.zibel_doc_delete?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
  expect(byName.zibel_tx_commit?.annotations).toMatchObject({ destructiveHint: false });
  expect(JSON.stringify(tools)).not.toContain("no effect yet");
  // Descriptions point at the Skill document instead of repeating its conventions.
  const described = (name: string) => (byName[name] as { description?: string })?.description;
  for (const name of ["zibel_doc_create", "zibel_node_create", "zibel_node_update"]) {
    expect(described(name)).toContain("skill://zibel/drawing-conventions");
  }
  expect(described("zibel_node_create")).not.toContain("origin top-left");
  expect(described("zibel_node_create")).toContain("text {");
  expect(described("zibel_node_create")).toContain("TEXT_OVERFLOW");
  expect(described("zibel_node_create")).toContain("MISSING_GLYPHS");
  expect(described("zibel_node_update")).toContain("leading");
  expect(described("zibel_node_create")).toContain("Bold Italic");
  expect(described("zibel_node_update")).toContain("fontStyle");
  for (const word of ["tracking", "ranges"]) expect(described("zibel_node_create")).toContain(word);
  expect(described("zibel_node_update")).toContain("ranges");
  expect(described("zibel_node_update")).toContain("clears");
  expect(described("zibel_node_create")).toContain("image {");
  expect(described("zibel_node_create")).toContain("missing link");
  expect(described("zibel_node_update")).toContain("preserveAspectRatio");
  // Relink and Embed (ADR-0042).
  expect(described("zibel_node_update")).not.toContain("src is read-only");
  for (const word of ["Relink", "file: null", "Embed", "INVALID_IMAGE"]) {
    expect(described("zibel_node_update")).toContain(word);
  }
  for (const key of ["src", "file"]) {
    expect(JSON.stringify(byName.zibel_node_update?.inputSchema)).toContain(`"${key}"`);
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
    expect(described("zibel_node_create")).toContain(param);
    expect(JSON.stringify(byName.zibel_node_update?.inputSchema)).toContain(`"${param}"`);
  }
  for (const word of ["gradient", "stops", "radial", "aspectRatio", "focus"]) {
    expect(described("zibel_node_create")).toContain(word);
    expect(JSON.stringify(byName.zibel_node_update?.inputSchema)).toContain(`"${word}"`);
  }
  expect(described("zibel_node_update")).toContain("gradient");
  for (const tool of ["zibel_doc_open", "zibel_svg_import"]) {
    expect(described(tool)).toContain("IMAGE_LINK_MISSING");
    expect(described(tool)).not.toContain("LINKED_IMAGE_DROPPED");
  }
  expect(described("zibel_doc_open")).not.toMatch(/\(gradients/);
  for (const t of tools) {
    expect(t.annotations, t.name).toEqual({
      readOnlyHint: expect.any(Boolean),
      destructiveHint: expect.any(Boolean),
      idempotentHint: expect.any(Boolean),
      // Only image_place reaches outside the service: it fetches a URL (ADR-0027).
      openWorldHint: t.name === "zibel_image_place",
    });
    expect(t.outputSchema, t.name).toMatchObject({ type: "object" });
  }
  // Core validates colours, but Agents still read the pattern from the published schema (§6.5).
  const nodeCreate = tools.find((t) => t.name === "zibel_node_create");
  expect(JSON.stringify(nodeCreate?.inputSchema)).toContain(
    JSON.stringify({ type: "string", pattern: COLOR_PATTERN }).slice(1, -1),
  );
});

it("publishes appearance with contents on layer and group in node_create and node_update (ADR-0043)", async () => {
  const { client } = await harness();
  const tools = (await client.listTools()).tools;
  const create = tools.find((t) => t.name === "zibel_node_create");
  if (!create) throw new Error("setup");
  const variants = (
    (create.inputSchema.properties as { nodes: unknown }).nodes as { items: { oneOf: object[] } }
  ).items.oneOf as { properties: Record<string, { const?: string; properties?: object }> }[];
  for (const type of ["layer", "group"]) {
    const v = variants.find((o) => o.properties.type?.const === type);
    expect(v?.properties.appearance?.properties, type).toHaveProperty("contents");
    expect(create.description).toContain(`${type} {`);
  }
  expect(create.description).toContain("contents");
  const update = tools.find((t) => t.name === "zibel_node_update");
  expect(JSON.stringify(update?.inputSchema)).toContain('"contents"');
  expect(update?.description).toContain("appearance: null removes it");
});

it("serves skill://zibel/drawing-conventions and points at it in the instructions", async () => {
  const uri = "skill://zibel/drawing-conventions";
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
    "zibel_doc_changes",
    "zibel_json",
    "zibel_doc_open",
    "INVALID_DOCUMENT",
    "SVG",
    "FONT_MISSING",
    "MISSING_GLYPHS",
    "LIMIT_EXCEEDED",
    "## Images",
    "INVALID_IMAGE",
    '"type": "gradient"',
    "aspectRatio",
    "zibel_image_place",
    "Template Layer",
  ]) {
    expect(text).toContain(fact);
  }
  // Drift guard: the document names only tools that exist; zibel_json is an export format.
  const tools = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const [name] of text.matchAll(/zibel_(?!json\b)[a-z_]+/g)) expect(tools).toContain(name);
  await expect(client.readResource({ uri: "skill://zibel/nope" })).rejects.toMatchObject({
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
  await call("zibel_node_create", { docId: "d", nodes: [{ type: "layer", name: "L" }] });
  await call("zibel_doc_outline", { docId: "d" });
  expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
    {
      actor: "agent-b",
      tool: "zibel_node_create",
      ms: expect.any(Number),
      nodes: 1,
      code: null,
      rev: 2,
    },
    {
      actor: "agent-b",
      tool: "zibel_doc_outline",
      ms: expect.any(Number),
      nodes: 0,
      code: "DOC_NOT_FOUND",
      rev: null,
    },
  ]);
});
