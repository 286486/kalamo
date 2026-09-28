import { evictAllDurableObjects } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { type ErrorCode, formatPath, type ShapeNode, shapeSegments } from "@zibel/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import exported from "../../../fixtures/documents/inkscape.svg?raw";
import { BLUE_1x1_PNG, RED_2x2_PNG, WEBP_HEADER } from "../../../fixtures/images.ts";
import { call, errorOf, rpc } from "./rpc.ts";

const newDoc = async () =>
  (await call("zibel_doc_create", { name: "Doc", artboards: [{ width: 200, height: 100 }] }))
    .structuredContent;

it("initializes without a session id", async () => {
  const { res, body } = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  expect(body.result.serverInfo.name).toBe("zibel");
  expect(res.headers.get("mcp-session-id")).toBeNull();
});

it("lists the tools over HTTP (their schemas and annotations: packages/mcp server.test.ts)", async () => {
  const { body } = await rpc("tools/list");
  const tools = body.result.tools as { name: string }[];
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
});

it("makes a Clipping Mask from a circle over a Group, renders it clipped and releases it", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const { keyMap } = (
    await call("zibel_node_create", {
      docId,
      nodes: [
        {
          type: "group",
          parentId: defaultLayerId,
          clientKey: "art",
          children: [{ type: "rect", x: 0, y: 0, width: 100, height: 100 }],
        },
        {
          type: "ellipse",
          parentId: defaultLayerId,
          clientKey: "circle",
          x: 20,
          y: 30,
          width: 40,
          height: 40,
        },
      ],
    })
  ).structuredContent;
  const made = (
    await call("zibel_mask_make", { docId, clipNodeId: keyMap.circle, contentIds: [keyMap.art] })
  ).structuredContent;
  const [maskId] = made.createdIds;
  expect(made.updatedIds.sort()).toEqual([keyMap.art, keyMap.circle].sort());
  const svg = (await call("zibel_export", { docId, format: "svg" })).content[0].text;
  expect(svg).toContain(`clip-path="url(#clip-z-${maskId})"`);
  expect(svg).toContain("<clipPath");
  // The Render Scope of the Clipping Mask is the circle's bounds, not the 100 pt square's.
  const { viewport } = (
    await call("zibel_render", { docId, scope: { nodeIds: [maskId] }, scale: 1 })
  ).structuredContent;
  expect(viewport.docRect).toMatchObject({ x: 20, y: 30, width: 40, height: 40 });

  await call("zibel_mask_release", { docId, nodeIds: [maskId] });
  const after = (await call("zibel_export", { docId, format: "svg" })).content[0].text;
  expect(after).not.toContain("clip-path");
  const { nodes } = (
    await call("zibel_node_get", { docId, nodeIds: [keyMap.circle, keyMap.art], detail: "full" })
  ).structuredContent;
  expect(nodes[0]).toMatchObject({ parentId: maskId, appearance: { fills: [], strokes: [] } });
  expect(nodes[0].clipping).toBeUndefined();
  expect(nodes[1]).toMatchObject({ parentId: maskId });
});

it("edits a path's Anchors with path_edit and converts a Live Shape first, with a warning", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const { keyMap } = (
    await call("zibel_node_create", {
      docId,
      nodes: [
        { type: "path", parentId: defaultLayerId, clientKey: "p", d: "M 0 0 L 10 0" },
        {
          type: "ellipse",
          parentId: defaultLayerId,
          clientKey: "e",
          x: 0,
          y: 0,
          width: 5,
          height: 5,
        },
      ],
    })
  ).structuredContent;
  const edited = (
    await call("zibel_path_edit", {
      docId,
      nodeId: keyMap.p,
      ops: [{ op: "add_anchor", segment: 0, t: 0.5 }, { op: "close" }],
    })
  ).structuredContent;
  expect(edited).toMatchObject({ updatedIds: [keyMap.p], d: "M 0 0 L 5 0 L 10 0 Z" });
  expect(edited.subpaths[0]).toMatchObject({ closed: true, anchors: [{ index: 0 }, {}, {}] });
  const { nodes } = (await call("zibel_node_get", { docId, nodeIds: [keyMap.p], detail: "full" }))
    .structuredContent;
  expect(nodes[0].d).toBe("M 0 0 L 5 0 L 10 0 Z");
  const converted = (
    await call("zibel_path_edit", { docId, nodeId: keyMap.e, ops: [{ op: "open" }] })
  ).structuredContent;
  expect(converted).toMatchObject({
    updatedIds: [keyMap.e],
    subpaths: [{ closed: false }],
    warnings: [{ code: "CONVERTED_TO_PATH", nodeId: keyMap.e }],
  });
});

it("converts a rect to a path with path_op, keeping its id", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const rect = {
    type: "rect",
    parentId: defaultLayerId,
    name: "Box",
    x: 20,
    y: 10,
    width: 120,
    height: 60,
    radius: 15,
  };
  const [id] = (await call("zibel_node_create", { docId, nodes: [rect] })).structuredContent
    .createdIds as string[];
  const receipt = (await call("zibel_path_op", { docId, nodeIds: [id], op: "convert_to_path" }))
    .structuredContent;
  expect(receipt).toMatchObject({ updatedIds: [id], createdIds: [], deletedIds: [] });
  const { nodes } = (await call("zibel_node_get", { docId, nodeIds: [id], detail: "full" }))
    .structuredContent;
  expect(nodes[0]).toMatchObject({ id, type: "path", name: "Box", parentId: defaultLayerId });
  expect(nodes[0]).not.toHaveProperty("radius");
});

it("reverses a path with path_op and adds an Anchor at the middle of every segment", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const d = "M 0 0 L 10 0 L 10 10";
  const [id] = (
    await call("zibel_node_create", {
      docId,
      nodes: [{ type: "path", parentId: defaultLayerId, d }],
    })
  ).structuredContent.createdIds as string[];
  const dOf = async () =>
    (await call("zibel_node_get", { docId, nodeIds: [id], detail: "full" })).structuredContent
      .nodes[0].d;
  const reversed = (await call("zibel_path_op", { docId, nodeIds: [id], op: "reverse" }))
    .structuredContent;
  expect(reversed).toMatchObject({ updatedIds: [id] });
  expect(await dOf()).toBe("M 10 10 L 10 0 L 0 0");
  await call("zibel_path_op", { docId, nodeIds: [id], op: "reverse" });
  expect(await dOf()).toBe(d);
  await call("zibel_path_op", { docId, nodeIds: [id], op: "add_anchors" });
  expect(await dOf()).toBe("M 0 0 L 5 0 L 10 0 L 10 5 L 10 10");
});

it("joins two open paths with path_op into the topmost in one Transaction, and averages Anchors", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [a, b] = (
    await call("zibel_node_create", {
      docId,
      nodes: [
        { type: "path", parentId: defaultLayerId, d: "M 0 0 L 10 0" },
        { type: "path", parentId: defaultLayerId, d: "M 30 0 L 20 0" },
      ],
    })
  ).structuredContent.createdIds as string[];
  const joined = (await call("zibel_path_op", { docId, nodeIds: [a, b], op: "join" }))
    .structuredContent;
  expect(joined).toMatchObject({ updatedIds: [b], deletedIds: [a] });
  const { changes } = (await call("zibel_doc_changes", { docId, sinceRev: joined.rev - 1 }))
    .structuredContent;
  expect(changes).toEqual([expect.objectContaining({ rev: joined.rev, summary: "Join" })]);
  const dOf = async () =>
    (await call("zibel_node_get", { docId, nodeIds: [b], detail: "full" })).structuredContent
      .nodes[0].d;
  expect(await dOf()).toBe("M 30 0 L 20 0 L 10 0 L 0 0");
  await call("zibel_path_op", { docId, nodeIds: [b], op: "join" });
  expect(await dOf()).toBe("M 30 0 L 20 0 L 10 0 L 0 0 Z");
  await call("zibel_path_op", {
    docId,
    nodeIds: [b],
    op: "average",
    anchors: [0, 1, 2].map((index) => ({ nodeId: b, subpath: 0, index })),
  });
  expect(await dOf()).toBe("M 20 0 L 20 0 L 20 0 L 0 0 Z");
});

it("simplifies a dense path with path_op in one Transaction, and to straight lines", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const points = Array.from({ length: 200 }, (_, i) => `${i} ${50 + 30 * Math.sin(i / 15)}`);
  const [id] = (
    await call("zibel_node_create", {
      docId,
      nodes: [{ type: "path", parentId: defaultLayerId, d: `M ${points.join(" L ")}` }],
    })
  ).structuredContent.createdIds as string[];
  const dOf = async () =>
    (await call("zibel_node_get", { docId, nodeIds: [id], detail: "full" })).structuredContent
      .nodes[0].d as string;
  const simplified = (await call("zibel_path_op", { docId, nodeIds: [id], op: "simplify" }))
    .structuredContent;
  expect(simplified).toMatchObject({ updatedIds: [id] });
  const { changes } = (await call("zibel_doc_changes", { docId, sinceRev: simplified.rev - 1 }))
    .structuredContent;
  expect(changes).toEqual([expect.objectContaining({ rev: simplified.rev, summary: "Simplify" })]);
  const d = await dOf();
  expect(d.startsWith("M 0 50 C")).toBe(true);
  expect(d.match(/[LC]/g)?.length).toBeLessThan(15);
  await call("zibel_path_op", { docId, nodeIds: [id], op: "simplify", toLines: true });
  expect(await dOf()).toMatch(/^M [\d. ]+( L [\d. ]+)+$/);
});

it("outlines Strokes with path_op: a Stroke alone in place, a filled path as a Group of two", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [line, rect] = (
    await call("zibel_node_create", {
      docId,
      nodes: [
        {
          type: "path",
          parentId: defaultLayerId,
          d: "M 20 50 L 180 50",
          appearance: { strokes: [{ color: "#FF0000", width: 10 }] },
        },
        {
          type: "rect",
          parentId: defaultLayerId,
          x: 10,
          y: 10,
          width: 40,
          height: 30,
          appearance: { fills: [{ color: "#00FF00" }], strokes: [{ color: "#0000FF", width: 4 }] },
        },
      ],
    })
  ).structuredContent.createdIds as string[];
  const receipt = (
    await call("zibel_path_op", { docId, nodeIds: [line, rect], op: "outline_stroke" })
  ).structuredContent;
  expect(receipt).toMatchObject({
    updatedIds: [line, rect],
    createdIds: [expect.any(String), expect.any(String)],
    warnings: [{ code: "CONVERTED_TO_PATH", nodeId: rect }],
  });
  const { changes } = (await call("zibel_doc_changes", { docId, sinceRev: receipt.rev - 1 }))
    .structuredContent;
  expect(changes).toEqual([
    expect.objectContaining({ rev: receipt.rev, summary: "Outline Stroke" }),
  ]);
  const [group, outline] = receipt.createdIds as [string, string];
  const { nodes } = (
    await call("zibel_node_get", { docId, nodeIds: [line, rect, group, outline], detail: "full" })
  ).structuredContent;
  expect(nodes).toMatchObject([
    {
      type: "path",
      d: "M 20 45 L 180 45 L 180 55 L 20 55 L 20 45 Z",
      appearance: { fills: [{ color: "#FF0000" }], strokes: [] },
    },
    {
      type: "path",
      parentId: group,
      d: "M 10 10 L 50 10 L 50 40 L 10 40 Z",
      appearance: { fills: [{ color: "#00FF00" }], strokes: [] },
    },
    { type: "group", parentId: defaultLayerId },
    {
      type: "path",
      parentId: group,
      fillRule: "nonzero",
      appearance: { fills: [{ color: "#0000FF" }], strokes: [] },
    },
  ]);
  // The ring the 4 pt Stroke paints, 2 pt each side of the rect's edge.
  expect(nodes[3].d.match(/M /g)).toHaveLength(2);
  expect(nodes[3].geometricBounds).toEqual({ x: 8, y: 8, width: 44, height: 34 });
});

it("offsets a 100 pt square by 10 pt into a 120 pt copy below it, in one Transaction", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [square] = (
    await call("zibel_node_create", {
      docId,
      nodes: [
        {
          type: "rect",
          parentId: defaultLayerId,
          x: 50,
          y: 50,
          width: 100,
          height: 100,
          appearance: { fills: [{ color: "#FF0000" }] },
        },
      ],
    })
  ).structuredContent.createdIds as string[];
  const receipt = (
    await call("zibel_path_op", {
      docId,
      nodeIds: [square],
      op: "offset",
      distance: 10,
      join: "miter",
    })
  ).structuredContent;
  expect(receipt).toMatchObject({ updatedIds: [], createdIds: [expect.any(String)], warnings: [] });
  const { changes } = (await call("zibel_doc_changes", { docId, sinceRev: receipt.rev - 1 }))
    .structuredContent;
  expect(changes).toEqual([expect.objectContaining({ rev: receipt.rev, summary: "Offset Path" })]);
  const [copy] = receipt.createdIds as [string];
  const { nodes } = (
    await call("zibel_node_get", { docId, nodeIds: [square, copy], detail: "full" })
  ).structuredContent;
  expect(nodes).toMatchObject([
    { type: "rect", width: 100, height: 100 },
    {
      type: "path",
      parentId: defaultLayerId,
      appearance: { fills: [{ color: "#FF0000" }] },
      geometricBounds: { x: 40, y: 40, width: 120, height: 120 },
    },
  ]);
  expect(nodes[1].d).toMatch(/^M [\d. ]+( L [\d. ]+)+ Z$/);
  expect(nodes[1].index < nodes[0].index).toBe(true);
});

it("divides a square under a circle into the inside and outside pieces and deletes the circle", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [square, circle] = (
    await call("zibel_node_create", {
      docId,
      nodes: [
        {
          type: "rect",
          parentId: defaultLayerId,
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          appearance: { fills: [{ color: "#FF0000" }] },
        },
        { type: "ellipse", parentId: defaultLayerId, x: 20, y: 20, width: 60, height: 60 },
      ],
    })
  ).structuredContent.createdIds as [string, string];
  const receipt = (await call("zibel_path_op", { docId, nodeIds: [circle], op: "divide_below" }))
    .structuredContent;
  expect(receipt).toMatchObject({
    updatedIds: [square],
    createdIds: [expect.any(String)],
    deletedIds: [circle],
  });
  const { changes } = (await call("zibel_doc_changes", { docId, sinceRev: receipt.rev - 1 }))
    .structuredContent;
  expect(changes).toEqual([
    expect.objectContaining({ rev: receipt.rev, summary: "Divide Objects Below" }),
  ]);
  const { nodes } = (
    await call("zibel_node_get", {
      docId,
      nodeIds: [square, ...(receipt.createdIds as string[])],
      detail: "full",
    })
  ).structuredContent;
  const red = { fills: [{ color: "#FF0000" }] };
  expect(nodes).toMatchObject([
    { type: "path", fillRule: "evenodd", appearance: red, geometricBounds: { width: 100 } },
    {
      type: "path",
      fillRule: "evenodd",
      appearance: red,
      geometricBounds: { x: 20, y: 20, width: 60, height: 60 },
    },
  ]);
  expect(nodes[0].d.match(/M /g)).toHaveLength(2);
  expect(nodes[0].index < nodes[1].index).toBe(true);
});

it("splits a 200x100 rect 2x3 into six rects and cleans up, reporting how many", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [rect] = (
    await call("zibel_node_create", {
      docId,
      nodes: [
        { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 200, height: 100 },
        { type: "path", parentId: defaultLayerId, d: "M 5 5" },
        {
          type: "rect",
          parentId: defaultLayerId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          appearance: {},
        },
      ],
    })
  ).structuredContent.createdIds as string[];
  const split = (
    await call("zibel_path_op", {
      docId,
      nodeIds: [rect],
      op: "split_into_grid",
      rows: 2,
      cols: 3,
      gutter: 10,
    })
  ).structuredContent;
  expect(split).toMatchObject({ deletedIds: [rect] });
  expect(split.createdIds).toHaveLength(6);
  expect(split.bounds).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  const cleaned = (await call("zibel_path_op", { docId, op: "clean_up" })).structuredContent;
  expect(cleaned.deletedIds).toHaveLength(2);
  const { changes } = (await call("zibel_doc_changes", { docId, sinceRev: split.rev - 1 }))
    .structuredContent;
  expect(changes.map((c: { summary: string }) => c.summary)).toEqual([
    "Split Into Grid",
    "Clean Up",
  ]);
});

it("draws a freehand_stroke as one smooth closed path", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const points = Array.from({ length: 61 }, (_, k) => ({
    x: 100 + 40 * Math.cos((Math.PI * k) / 30),
    y: 50 + 40 * Math.sin((Math.PI * k) / 30),
  }));
  const [id] = (
    await call("zibel_freehand_stroke", { docId, parentId: defaultLayerId, points, tool: "pencil" })
  ).structuredContent.createdIds as string[];
  const { nodes } = (await call("zibel_node_get", { docId, nodeIds: [id], detail: "full" }))
    .structuredContent;
  expect(nodes[0]).toMatchObject({ type: "path", parentId: defaultLayerId, closed: true });
  expect(nodes[0].appearance).toMatchObject({
    fills: [],
    strokes: [{ color: "#000000", width: 1 }],
  });
  expect(nodes[0].geometricBounds.width).toBeCloseTo(80, 0);
});

it("places a PNG as an Image: node_get has its id, render draws it, export and open keep it", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const image = { type: "image", parentId: defaultLayerId, src: RED_2x2_PNG, x: 10, y: 10 };
  const [id] = (await call("zibel_node_create", { docId, nodes: [image] })).structuredContent
    .createdIds as string[];
  const { nodes } = (await call("zibel_node_get", { docId, nodeIds: [id], detail: "full" }))
    .structuredContent;
  expect(nodes[0]).toMatchObject({
    type: "image",
    width: 2,
    height: 2,
    src: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(JSON.stringify(nodes)).not.toContain("data:");
  const rendered = await call("zibel_render", { docId, scope: { nodeIds: [id] }, scale: 1 });
  expect(rendered.structuredContent.viewport.pixelSize).toEqual({ width: 2, height: 2 });
  const svg = (await call("zibel_export", { docId, format: "svg" })).content[0].text;
  expect(svg).toContain(`xlink:href="${RED_2x2_PNG}"`);
  const opened = (await call("zibel_doc_open", { content: svg })).structuredContent;
  const back = (
    await call("zibel_node_get", { docId: opened.docId, nodeIds: [id], detail: "full" })
  ).structuredContent;
  expect(back.nodes[0]).toMatchObject({ src: nodes[0].src });
});

it("node_update Relinks an Image with src and file (ADR-0042)", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const image = { type: "image", parentId: defaultLayerId, src: RED_2x2_PNG, x: 10, y: 10 };
  const [nodeId] = (await call("zibel_node_create", { docId, nodes: [image] })).structuredContent
    .createdIds as string[];
  const relinked = await call("zibel_node_update", {
    docId,
    updates: [{ nodeId, patch: { src: BLUE_1x1_PNG, file: "blue.png" } }],
  });
  expect(relinked.structuredContent.updatedIds).toEqual([nodeId]);
});

it("opens an SVG that links its photos as missing links, with one warning (ADR-0042)", async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:zibel="https://zibel.dev/ns/svg" width="100" height="100"><image x="5" y="5" width="30" height="20" xlink:href="photo.png"/><image width="10" height="10" href="b.png" zibel:src="${"a".repeat(64)}"/><image href="unsized.png"/></svg>`;
  const opened = (await call("zibel_doc_open", { content: svg })).structuredContent;
  expect(opened.warnings.map((w: { code: string }) => w.code).sort()).toEqual([
    "IMAGE_LINK_MISSING",
    "INVALID_IMAGE",
  ]);
  const [layer] = opened.nodes;
  const { nodes } = (
    await call("zibel_doc_outline", { docId: opened.docId, rootId: layer.id, depth: 1 })
  ).structuredContent;
  const full = (
    await call("zibel_node_get", {
      docId: opened.docId,
      nodeIds: nodes.map((n: { id: string }) => n.id),
      detail: "full",
    })
  ).structuredContent.nodes;
  expect(full).toMatchObject([
    { type: "image", file: "photo.png", x: 5, y: 5, width: 30, height: 20 },
    { type: "image", file: "b.png" },
  ]);
  expect(full.some((n: object) => "src" in n)).toBe(false);
});

it("creates a missing link from file and a frame (ADR-0042)", async () => {
  const { docId, defaultLayerId: parentId } = await newDoc();
  const missing = {
    type: "image",
    parentId,
    file: "photo.png",
    x: 10,
    y: 10,
    width: 30,
    height: 20,
  };
  const result = await call("zibel_node_create", { docId, nodes: [missing] });
  expect(result.structuredContent.createdIds).toHaveLength(1);
});

it("keeps a style Zibel lacks and warns FONT_MISSING naming the face it renders in", async () => {
  const doc = await newDoc();
  const created = await call("zibel_node_create", {
    docId: doc.docId,
    nodes: [
      {
        type: "text",
        parentId: doc.defaultLayerId,
        x: 10,
        y: 50,
        content: "Hi",
        fontStyle: "Semibold",
      },
    ],
  });
  const [id] = created.structuredContent.createdIds as string[];
  expect(created.structuredContent.warnings).toEqual([
    expect.objectContaining({
      code: "FONT_MISSING",
      nodeId: id,
      message: expect.stringContaining("renders in Source Sans 3 Bold"),
    }),
  ]);
  const [full] = (await call("zibel_node_get", { docId: doc.docId, nodeIds: [id], detail: "full" }))
    .structuredContent.nodes;
  expect(full).toMatchObject({ fontStyle: "Semibold" });
  const updated = await call("zibel_node_update", {
    docId: doc.docId,
    updates: [{ nodeId: id, patch: { fontStyle: "Black Italic" } }],
  });
  expect(updated.structuredContent.warnings).toEqual([]);
});

it("keeps a font Zibel lacks, warns FONT_MISSING and renders it in Source Sans 3", async () => {
  const doc = await newDoc();
  const created = await call("zibel_node_create", {
    docId: doc.docId,
    nodes: [
      {
        type: "text",
        parentId: doc.defaultLayerId,
        x: 10,
        y: 50,
        content: "Hi",
        fontFamily: "Helvetica",
      },
    ],
  });
  const [id] = created.structuredContent.createdIds as string[];
  expect(created.structuredContent.warnings).toEqual([
    expect.objectContaining({ code: "FONT_MISSING", nodeId: id }),
  ]);
  const updated = await call("zibel_node_update", {
    docId: doc.docId,
    updates: [{ nodeId: id, patch: { content: "Ho" } }],
  });
  expect(updated.structuredContent.warnings).toEqual([
    expect.objectContaining({ code: "FONT_MISSING", nodeId: id }),
  ]);
  const [full] = (await call("zibel_node_get", { docId: doc.docId, nodeIds: [id], detail: "full" }))
    .structuredContent.nodes;
  expect(full).toMatchObject({ fontFamily: "Helvetica" });
  const svg = await call("zibel_export", { docId: doc.docId, format: "svg" });
  expect(svg.content[0].text).toContain('font-family="Helvetica"');
  const rendered = await call("zibel_render", { docId: doc.docId });
  expect(rendered.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
});

it("creates a rounded, randomized, twisted star and gets its parameters and derived d", async () => {
  const doc = await newDoc();
  const params = { angle: 15, twist: 10, rounded: 0.3, randomized: 0.1 };
  const star = { cx: 50.5, cy: 40, outerRadius: 30, innerRadius: 12, points: 5, ...params };
  const created = await call("zibel_node_create", {
    docId: doc.docId,
    nodes: [{ type: "star", parentId: doc.defaultLayerId, ...star }],
  });
  const [id] = created.structuredContent.createdIds as string[];
  const [full] = (await call("zibel_node_get", { docId: doc.docId, nodeIds: [id], detail: "full" }))
    .structuredContent.nodes;
  expect(full).toMatchObject({ type: "star", ...star });
  expect(full.d).toContain("C");
  expect(full.d).toBe(formatPath(shapeSegments(full as ShapeNode)));
});

it("creates a slice, a chord and an open arc of an ellipse, and renders a quarter pie over its own bounds", async () => {
  const doc = await newDoc();
  const box = { type: "ellipse", parentId: doc.defaultLayerId, x: 0, y: 0, width: 100, height: 60 };
  const cuts = [
    { startAngle: 0, endAngle: 270, arcType: "slice" },
    { startAngle: 0, endAngle: 270, arcType: "chord" },
    { startAngle: 0, endAngle: 270, arcType: "open" },
    { startAngle: 0, endAngle: 90, arcType: "slice" },
  ];
  const created = await call("zibel_node_create", {
    docId: doc.docId,
    nodes: cuts.map((cut) => ({ ...box, ...cut })),
  });
  const ids = created.structuredContent.createdIds as string[];
  const nodes = (await call("zibel_node_get", { docId: doc.docId, nodeIds: ids, detail: "full" }))
    .structuredContent.nodes;
  nodes.forEach((n: ShapeNode & { d: string }, i: number) => {
    expect(n).toMatchObject(cuts[i] ?? {});
    expect(n.d).toBe(formatPath(shapeSegments(n)));
  });
  const [slice, chord, open] = nodes;
  expect(slice.d).toMatch(/ 50 0 L 50 30 Z$/);
  expect(chord.d).toMatch(/ 50 0 Z$/);
  expect(open.d).toMatch(/ 50 0$/);
  expect([slice.closed, chord.closed, open.closed]).toEqual([true, true, false]);
  const quarter = await call("zibel_render", { docId: doc.docId, scope: { nodeIds: [ids[3]] } });
  expect(quarter.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  // The quarter's visible bounds, its default 1 pt Stroke included, not the whole ellipse's.
  expect(quarter.structuredContent.viewport.docRect).toEqual({
    x: 49.5,
    y: 29.5,
    width: 51,
    height: 31,
  });
});

it("fills in a gradient's geometry, reads it back in full, and names start = end", async () => {
  const doc = await newDoc();
  const stops = [
    { offset: 0, color: "#1F5FBF" },
    { offset: 1, color: "#9FD0FF00" },
  ];
  const created = await call("zibel_node_create", {
    docId: doc.docId,
    nodes: [
      {
        type: "rect",
        parentId: doc.defaultLayerId,
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        appearance: { fills: [{ type: "gradient", gradient: { type: "linear", stops } }] },
      },
    ],
  });
  const [id] = created.structuredContent.createdIds as string[];
  const get = async () =>
    (await call("zibel_node_get", { docId: doc.docId, nodeIds: [id], detail: "full" }))
      .structuredContent.nodes[0];
  expect((await get()).appearance.fills).toEqual([
    {
      type: "gradient",
      gradient: { type: "linear", stops, start: { x: 10, y: 45 }, end: { x: 110, y: 45 } },
    },
  ]);
  const strokes = [{ type: "gradient", gradient: { type: "radial", stops }, width: 4 }];
  const updated = await call("zibel_node_update", {
    docId: doc.docId,
    updates: [{ nodeId: id, patch: { appearance: { strokes } } }],
  });
  expect(updated.isError).toBeFalsy();
  expect((await get()).appearance.strokes[0].gradient).toMatchObject({
    center: { x: 60, y: 45 },
    radius: 39.528,
    focus: { x: 60, y: 45 },
  });
  const flat = { type: "linear", stops, start: { x: 0, y: 0 }, end: { x: 0, y: 0 } };
  const refused = await call("zibel_node_update", {
    docId: doc.docId,
    updates: [
      { nodeId: id, patch: { appearance: { fills: [{ type: "gradient", gradient: flat }] } } },
    ],
  });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toMatch(/Input validation error[\s\S]*end/);
});

it("stores Character Ranges canonical, and a content write clears them (ADR-0029)", async () => {
  const doc = await newDoc();
  const created = await call("zibel_node_create", {
    docId: doc.docId,
    nodes: [
      {
        type: "text",
        parentId: doc.defaultLayerId,
        x: 10,
        y: 50,
        content: "LITTLE",
        tracking: 100,
        ranges: [
          { start: 0, end: 3, fill: "#FF0000" },
          { start: 2, end: 6, fill: "#0000FF80", baselineShift: 2, rotation: -10 },
        ],
      },
    ],
  });
  const [id] = created.structuredContent.createdIds as string[];
  const get = async () =>
    (await call("zibel_node_get", { docId: doc.docId, nodeIds: [id], detail: "full" }))
      .structuredContent.nodes[0];
  expect(await get()).toMatchObject({
    tracking: 100,
    ranges: [
      { start: 0, end: 2, fill: "#FF0000" },
      { start: 2, end: 6, fill: "#0000FF80", baselineShift: 2, rotation: -10 },
    ],
  });
  await call("zibel_node_update", {
    docId: doc.docId,
    updates: [{ nodeId: id, patch: { content: "BIG" } }],
  });
  expect(await get()).not.toHaveProperty("ranges");
});

it("warns TEXT_OVERFLOW while an Area Type's content does not fit its frame", async () => {
  const doc = await newDoc();
  const created = await call("zibel_node_create", {
    docId: doc.docId,
    nodes: [
      {
        type: "text",
        kind: "area",
        parentId: doc.defaultLayerId,
        x: 10,
        y: 10,
        width: 100,
        height: 20,
        content: "one\ntwo\nthree",
      },
    ],
  });
  const [id] = created.structuredContent.createdIds as string[];
  expect(created.structuredContent.warnings).toEqual([
    expect.objectContaining({ code: "TEXT_OVERFLOW", nodeId: id }),
  ]);
  const updated = await call("zibel_node_update", {
    docId: doc.docId,
    updates: [{ nodeId: id, patch: { height: 80 } }],
  });
  expect(updated.structuredContent.warnings).toEqual([]);
});

it("creates a rect in the default Layer and reads it back from doc_outline", async () => {
  const doc = await newDoc();
  expect(doc).toMatchObject({
    docId: expect.any(String),
    defaultLayerId: expect.any(String),
    rev: 1,
  });

  const created = await call("zibel_node_create", {
    docId: doc.docId,
    nodes: [{ type: "rect", parentId: doc.defaultLayerId, x: 10, y: 10, width: 50, height: 30 }],
  });
  expect(created.structuredContent).toMatchObject({
    rev: 2,
    bounds: { x: 10, y: 10, width: 50, height: 30 },
  });
  const [rectId] = created.structuredContent.createdIds;

  const read = async () =>
    (await call("zibel_doc_outline", { docId: doc.docId })).structuredContent;
  const expected = {
    rev: 2,
    nodes: [
      {
        id: doc.defaultLayerId,
        type: "layer",
        children: [{ id: rectId, type: "rect", bounds: { x: 10, y: 10, width: 50, height: 30 } }],
      },
    ],
  };
  expect(await read()).toMatchObject(expected);

  await evictAllDurableObjects();
  expect(await read()).toMatchObject(expected);
});

it("lists Documents created in earlier requests, newest first, with doc_list", async () => {
  const create = async (name: string) =>
    (await call("zibel_doc_create", { name, artboards: [{ width: 10, height: 10 }] }))
      .structuredContent.docId;
  const first = await create("First");
  const second = await create("Second");
  const { documents } = (await call("zibel_doc_list", {})).structuredContent;
  expect(documents.slice(0, 2)).toEqual([
    { docId: second, name: "Second", createdAt: expect.any(String), role: "owner" },
    { docId: first, name: "First", createdAt: expect.any(String), role: "owner" },
  ]);
});

it("reports name, Artboards, node count, rev and no browsers with doc_get_info", async () => {
  const { docId, defaultLayerId, artboards } = await newDoc();
  await call("zibel_node_create", {
    docId,
    nodes: [{ type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 10, height: 10 }],
  });
  const result = await call("zibel_doc_get_info", { docId });
  expect(result.structuredContent).toEqual({
    docId,
    name: "Doc",
    artboards,
    nodeCount: 2,
    rev: 2,
    browsers: 0,
  });
});

it("answers GET and DELETE with 405: no standalone stream and no sessions (ADR-0006)", async () => {
  for (const method of ["GET", "DELETE"]) {
    const res = await exports.default.fetch("http://zibel/mcp", {
      method,
      headers: { accept: "text/event-stream", authorization: "Bearer dev-token-a" },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  }
});

describe("edit tools", () => {
  const setup = async () => {
    const doc = await newDoc();
    const make = async (nodes: object[]) =>
      (await call("zibel_node_create", { docId: doc.docId, nodes })).structuredContent;
    const full = async (id: string) =>
      (await call("zibel_node_get", { docId: doc.docId, nodeIds: [id], detail: "full" }))
        .structuredContent.nodes[0];
    const rect = {
      type: "rect",
      parentId: doc.defaultLayerId,
      x: 10,
      y: 10,
      width: 50,
      height: 30,
    };
    return { doc, make, full, rect };
  };

  it("updates, transforms and deletes a rect, with every receipt field", async () => {
    const { doc, make, full, rect } = await setup();
    const [id] = (await make([rect])).createdIds;

    const updated = await call("zibel_node_update", {
      docId: doc.docId,
      updates: [
        { nodeId: id, patch: { name: "Box", appearance: { fills: [{ color: "#FF0000" }] } } },
      ],
    });
    expect(updated.structuredContent).toEqual({
      txId: expect.any(String),
      rev: 3,
      createdIds: [],
      updatedIds: [id],
      deletedIds: [],
      keyMap: {},
      bounds: { x: 10, y: 10, width: 50, height: 30 },
      warnings: [],
    });
    expect(await full(id)).toMatchObject({
      name: "Box",
      appearance: { fills: [{ color: "#FF0000" }], strokes: [{ color: "#000000", width: 1 }] },
    });

    const turned = await call("zibel_node_transform", {
      docId: doc.docId,
      nodeIds: [id],
      rotate: 90,
    });
    expect(turned.structuredContent).toEqual({
      txId: expect.any(String),
      rev: 4,
      createdIds: [],
      updatedIds: [id],
      deletedIds: [],
      keyMap: {},
      bounds: { x: 20, y: 0, width: 30, height: 50 },
      warnings: [],
    });
    expect(await full(id)).toMatchObject({
      x: 10,
      y: 10,
      width: 50,
      height: 30,
      transform: [0, 1, -1, 0, 60, -10],
      worldTransform: [0, 1, -1, 0, 60, -10],
      geometricBounds: { x: 20, y: 0, width: 30, height: 50 },
    });
    const rendered = await call("zibel_render", { docId: doc.docId });
    expect(rendered.content.find((c: { type: string }) => c.type === "image")?.mimeType).toBe(
      "image/png",
    );

    const deleted = await call("zibel_node_delete", { docId: doc.docId, nodeIds: [id] });
    expect(deleted.structuredContent).toEqual({
      txId: expect.any(String),
      rev: 5,
      createdIds: [],
      updatedIds: [],
      deletedIds: [id],
      keyMap: {},
      bounds: { x: 20, y: 0, width: 30, height: 50 },
      warnings: [],
    });
  });
});

describe("transactions", () => {
  afterEach(() => vi.useRealTimers());

  /** A Document with one committed rect (rev 2), and helpers bound to it. */
  const setup = async () => {
    const doc = await newDoc();
    const docId = doc.docId as string;
    const rect = {
      type: "rect",
      parentId: doc.defaultLayerId,
      x: 10,
      y: 10,
      width: 50,
      height: 30,
    };
    const tool = async (name: string, args: object = {}, token?: string) =>
      call(`zibel_${name}`, { docId, ...args }, token);
    const ok = async (name: string, args: object = {}, token?: string) => {
      const result = await tool(name, args, token);
      if (result.isError) throw new Error(result.content[0].text);
      return result.structuredContent;
    };
    const err = async (name: string, args: object = {}, token?: string) =>
      errorOf(await tool(name, args, token));
    const [rectId] = (await ok("node_create", { nodes: [rect] })).createdIds;
    const children = async (txId?: string) =>
      (await ok("doc_outline", { txId })).nodes[0].children?.map((c: { id: string }) => c.id) ?? [];
    return { docId, rect, rectId, tool, ok, err, children };
  };

  it("shows uncommitted edits only to reads carrying the txId, then commits them in one rev", async () => {
    const { rect, rectId, ok, err, children } = await setup();
    const { txId, rev } = await ok("tx_begin", { label: "Add a box" });
    expect(rev).toBe(2);
    const made = await ok("node_create", { nodes: [rect], txId });
    expect(made).toMatchObject({ txId, rev: 2 });
    const [id] = made.createdIds;
    await ok("node_update", { updates: [{ nodeId: id, patch: { name: "box" } }], txId });
    await ok("node_transform", { nodeIds: [id], translate: { x: 5 }, txId });

    expect((await ok("node_get", { nodeIds: [id], txId })).nodes).toMatchObject([
      { name: "box", geometricBounds: { x: 15 } },
    ]);
    expect(await err("node_get", { nodeIds: [id] })).toMatchObject({ code: "NODE_NOT_FOUND" });
    expect(await children(txId)).toEqual([rectId, id]);
    expect(await children()).toEqual([rectId]);
    const png = await ok("render", { txId });
    expect(png.viewport.docRect).toBeDefined();
    expect((await ok("doc_outline")).rev).toBe(2);

    expect(await ok("tx_commit", { txId })).toMatchObject({
      txId,
      rev: 3,
      createdIds: [id],
      updatedIds: [],
      deletedIds: [],
    });
    expect(await children()).toEqual([rectId, id]);
    expect((await ok("node_get", { nodeIds: [id] })).nodes).toMatchObject([{ name: "box" }]);
    expect(await ok("doc_changes", { sinceRev: 2 })).toMatchObject({
      rev: 3,
      changes: [{ rev: 3, txId, summary: "Add a box", createdIds: [id] }],
    });
  });

  it("rolls back to the Document exactly as it was before tx_begin", async () => {
    const { rect, rectId, ok, err } = await setup();
    const before = await ok("doc_outline", { depth: 5 });
    const changes = await ok("doc_changes", { sinceRev: 0 });
    const { txId } = await ok("tx_begin");
    await ok("node_create", { nodes: [rect], txId });
    await ok("node_update", { updates: [{ nodeId: rectId, patch: { name: "x" } }], txId });
    await ok("node_delete", { nodeIds: [rectId], txId });
    expect(await ok("tx_rollback", { txId })).toEqual({ txId, rev: 2 });
    expect(await ok("doc_outline", { depth: 5 })).toEqual(before);
    expect((await ok("node_get", { nodeIds: [rectId], detail: "full" })).nodes).toMatchObject([
      { name: "" },
    ]);
    expect(await ok("doc_changes", { sinceRev: 0 })).toEqual(changes);
    expect(await err("node_get", { nodeIds: [rectId], txId })).toMatchObject({
      code: "TX_EXPIRED",
      hint: expect.stringContaining("rolled back"),
    });
  });

  it("lists Transactions from two Actors in doc_changes with their attribution", async () => {
    const { rect, rectId, ok, err } = await setup();
    await ok(
      "node_update",
      { updates: [{ nodeId: rectId, patch: { name: "b" } }], intent: "rename" },
      "dev-token-b",
    );
    const { txId } = await ok("tx_begin", { label: "Two boxes" });
    const { createdIds } = await ok("node_create", { nodes: [rect, rect], txId });
    await ok("tx_commit", { txId, intent: "more boxes" });
    expect(await ok("doc_changes", { sinceRev: 1 })).toEqual({
      rev: 4,
      changes: [
        expect.objectContaining({ rev: 2, actor: "agent-a", createdIds: [rectId] }),
        expect.objectContaining({
          rev: 3,
          actor: "agent-b",
          updatedIds: [rectId],
          intent: "rename",
        }),
        {
          rev: 4,
          txId,
          actor: "agent-a",
          summary: "Two boxes",
          createdIds,
          updatedIds: [],
          deletedIds: [],
          intent: "more boxes",
        },
      ],
    });
    expect(await ok("doc_changes", { sinceRev: 1, limit: 1 })).toMatchObject({
      rev: 4,
      changes: [{ rev: 2 }],
    });
    expect(await err("node_create", { nodes: [rect], txId: "01NOPE" })).toMatchObject({
      code: "TX_NOT_FOUND",
    });
  });
});

describe("node_query", () => {
  it("pages through more than one page with cursor, in id order", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const rect = { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 1, height: 1 };
    const created = (
      await call("zibel_node_create", { docId, nodes: Array.from({ length: 5 }, () => rect) })
    ).structuredContent.createdIds as string[];
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = (await call("zibel_node_query", { docId, types: ["rect"], limit: 2, cursor }))
        .structuredContent;
      pages.push(page.nodes.map((n: { id: string }) => n.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toEqual([...created].sort());
  });
});

it("returns a non-empty hint with every error code a tool can return", async () => {
  const doc = await newDoc();
  const { docId, defaultLayerId } = doc;
  const tool = async (name: string, args: object) => errorOf(await call(name, { docId, ...args }));
  const rect = { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 1, height: 1 };
  const create = async (node: object) =>
    (await call("zibel_node_create", { docId, nodes: [node] })).structuredContent.createdIds[0];
  // A new ErrorCode fails tsc here until it gets a trigger.
  const triggers: Record<ErrorCode, (() => Promise<{ code: string; hint: string }>) | null> = {
    DOC_NOT_FOUND: () => call("zibel_doc_get_info", { docId: "nope" }).then(errorOf),
    NODE_NOT_FOUND: () => tool("zibel_node_get", { nodeIds: ["nope"] }),
    ARTBOARD_NOT_FOUND: () => tool("zibel_render", { scope: { artboardId: "nope" } }),
    NOTHING_TO_RENDER: async () =>
      tool("zibel_render", {
        scope: { nodeIds: [await create({ type: "group", parentId: defaultLayerId })] },
      }),
    INVALID_PARENT: () =>
      tool("zibel_node_create", { nodes: [{ ...rect, parentId: doc.artboards[0].id }] }),
    INVALID_COLOR: () => tool("zibel_render", { background: "red" }),
    INVALID_PATH: () =>
      tool("zibel_node_create", { nodes: [{ type: "path", parentId: defaultLayerId, d: "h 1" }] }),
    INVALID_PATCH: () =>
      tool("zibel_node_update", { updates: [{ nodeId: defaultLayerId, patch: { type: "rect" } }] }),
    INVALID_INPUT: () =>
      tool("zibel_node_create", {
        nodes: [{ type: "group", parentId: defaultLayerId, appearance: { contents: 1 } }],
      }),
    LIMIT_EXCEEDED: () => tool("zibel_node_create", { nodes: Array(2001).fill(rect) }),
    PERMISSION_DENIED: async () => (await rpc("tools/list", {}, "nope")).body.error.data,
    REV_CONFLICT: () => tool("zibel_node_create", { nodes: [rect], ifRev: 99 }),
    NODE_GONE: async () => {
      const id = await create(rect);
      const { txId } = (await call("zibel_tx_begin", { docId })).structuredContent;
      await call("zibel_node_update", { docId, txId, updates: [{ nodeId: id, patch: { x: 1 } }] });
      await call("zibel_node_delete", { docId, nodeIds: [id] });
      return tool("zibel_tx_commit", { txId });
    },
    TX_NOT_FOUND: () => tool("zibel_tx_commit", { txId: "nope" }),
    TX_EXPIRED: async () => {
      const { txId } = (await call("zibel_tx_begin", { docId })).structuredContent;
      await call("zibel_tx_rollback", { docId, txId });
      return tool("zibel_tx_commit", { txId });
    },
    INVALID_DOCUMENT: () => call("zibel_doc_open", { content: "{" }).then(errorOf),
    INVALID_IMAGE: () =>
      tool("zibel_node_create", {
        nodes: [{ type: "image", parentId: defaultLayerId, src: WEBP_HEADER, x: 0, y: 0 }],
      }),
    FETCH_FAILED: () =>
      tool("zibel_image_place", { src: "http://127.0.0.1/a.png", parentId: defaultLayerId }),
    INVALID_MASK: async () =>
      tool("zibel_mask_make", { clipNodeId: defaultLayerId, contentIds: [await create(rect)] }),
    // Undo and redo are browser commands over the WebSocket, not tools (ADR-0011).
    NOTHING_TO_UNDO: null,
    NOTHING_TO_REDO: null,
    // packages/geometry raises it; no tool calls geometry yet (ADR-0034).
    BOOLEAN_FAILED: null,
  };
  for (const [code, trigger] of Object.entries(triggers)) {
    if (!trigger) continue;
    expect(await trigger(), code).toMatchObject({ code, hint: expect.stringMatching(/\S/) });
  }
});

it("serves skill://zibel/drawing-conventions over HTTP and points at it on initialize", async () => {
  // Its facts and the drift guard: packages/mcp server.test.ts.
  const uri = "skill://zibel/drawing-conventions";
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  expect(init.body.result.instructions).toContain(uri);
  const listed = (await rpc("resources/list")).body.result.resources;
  expect(listed).toContainEqual(expect.objectContaining({ uri, mimeType: "text/markdown" }));
  const [doc] = (await rpc("resources/read", { uri })).body.result.contents;
  expect(doc).toMatchObject({
    uri,
    mimeType: "text/markdown",
    text: expect.stringContaining("#RRGGBB"),
  });
});

describe("zibel_json", () => {
  it("exports the whole Document as .zibel.json text, with a Transaction's edits under its txId", async () => {
    const doc = await newDoc();
    const { docId, defaultLayerId } = doc;
    const rect = { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 10, height: 10 };
    const [rectId] = (await call("zibel_node_create", { docId, nodes: [rect] })).structuredContent
      .createdIds;
    const result = await call("zibel_export", { docId, format: "zibel_json" });
    expect(result.structuredContent).toEqual({});
    expect(result.content[0].type).toBe("text");
    const text = result.content[0].text;
    const file = JSON.parse(text);
    expect(file).toMatchObject({ version: 1, name: "Doc", artboards: doc.artboards });
    expect(file.nodes).toHaveLength(2);
    const scoped = await call("zibel_export", {
      docId,
      format: "zibel_json",
      scope: { nodeIds: [rectId] },
    });
    expect(scoped.content[0].text).toBe(text);
    const { txId } = (await call("zibel_tx_begin", { docId })).structuredContent;
    await call("zibel_node_create", { docId, txId, nodes: [rect] });
    const nodesOf = async (args: object) =>
      JSON.parse(
        (await call("zibel_export", { docId, format: "zibel_json", ...args })).content[0].text,
      ).nodes;
    expect(await nodesOf({ txId })).toHaveLength(3);
    expect(await nodesOf({})).toHaveLength(2);
  });

  it("opens an exported file as a new Document that keeps its ids and exports the same text", async () => {
    const doc = await newDoc();
    const { docId, defaultLayerId: parentId } = doc;
    const { keyMap } = (
      await call("zibel_node_create", {
        docId,
        nodes: [
          { type: "layer", name: "Top" },
          {
            type: "group",
            parentId,
            children: [{ type: "rect", clientKey: "rect", x: 1, y: 2, width: 3, height: 4 }],
          },
          { type: "ellipse", parentId, x: 0, y: 0, width: 5, height: 5 },
          { type: "line", parentId, x1: 0, y1: 0, x2: 5, y2: 5 },
          { type: "polygon", parentId, cx: 9, cy: 9, radius: 4, sides: 5 },
          { type: "star", parentId, cx: 9, cy: 9, outerRadius: 4, innerRadius: 2, points: 5 },
          { type: "path", parentId, d: "M 0 0 C 1 1 2 2 3 0 Q 4 4 0 0 Z" },
          {
            type: "text",
            parentId,
            clientKey: "text",
            x: 0,
            y: 20,
            content: "Hi",
            meta: { b: 1, a: [2] },
          },
        ],
      })
    ).structuredContent;
    await call("zibel_node_transform", { docId, nodeIds: [keyMap.rect], rotate: 30 });
    await call("zibel_node_update", {
      docId,
      updates: [{ nodeId: keyMap.text, patch: { name: "Title", tags: ["t"] } }],
    });
    const exportOf = async (id: string) =>
      (await call("zibel_export", { docId: id, format: "zibel_json" })).content[0].text as string;
    const text = await exportOf(docId);

    const opened = await call("zibel_doc_open", { content: text, intent: "reopen" });
    const { docId: newId, ...rest } = opened.structuredContent;
    expect(newId).not.toBe(docId);
    expect(rest).toEqual({
      name: "Doc",
      artboards: doc.artboards,
      rev: 1,
      warnings: [],
      nodes: [
        expect.objectContaining({
          id: parentId,
          type: "layer",
          childCount: 7,
          bounds: expect.any(Object),
        }),
        expect.objectContaining({ type: "layer", name: "Top", childCount: 0, bounds: null }),
      ],
    });
    expect(rest.nodes[0]).not.toHaveProperty("children");
    expect(await exportOf(newId)).toBe(text);
    const [rect] = (
      await call("zibel_node_get", { docId: newId, nodeIds: [keyMap.rect], detail: "full" })
    ).structuredContent.nodes;
    expect(rect).toMatchObject({ id: keyMap.rect, type: "rect", width: 3 });
    const { changes } = (await call("zibel_doc_changes", { docId: newId, sinceRev: 0 }))
      .structuredContent;
    expect(changes).toEqual([
      expect.objectContaining({
        rev: 1,
        actor: "agent-a",
        summary: 'Open Document "Doc"',
        intent: "reopen",
        createdIds: expect.arrayContaining([keyMap.rect, keyMap.text]),
      }),
    ]);
    const { documents } = (await call("zibel_doc_list", {})).structuredContent;
    expect(documents[0]).toEqual({
      docId: newId,
      name: "Doc",
      createdAt: expect.any(String),
      role: "owner",
    });
  });

  it("returns a validation error with a path and creates nothing for a malformed file", async () => {
    const count = async () => (await call("zibel_doc_list", {})).structuredContent.documents.length;
    const before = await count();
    const notJson = errorOf(await call("zibel_doc_open", { content: "{" }));
    expect(notJson).toMatchObject({
      code: "INVALID_DOCUMENT",
      path: "content",
      hint: expect.stringMatching(/\S/),
    });
    const { docId, defaultLayerId } = await newDoc();
    await call("zibel_node_create", {
      docId,
      nodes: [{ type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 1, height: 1 }],
    });
    const file = JSON.parse(
      (await call("zibel_export", { docId, format: "zibel_json" })).content[0].text,
    );
    const i = file.nodes.findIndex((n: { type: string }) => n.type === "rect");
    file.nodes[i].appearance.fills[0].color = "red";
    const badColor = errorOf(await call("zibel_doc_open", { content: JSON.stringify(file) }));
    expect(badColor).toMatchObject({
      code: "INVALID_COLOR",
      path: `nodes[${i}].appearance.fills[0].color`,
    });
    expect(await count()).toBe(before + 1);
  });
});

it("places an SVG as one Group under the parent, and refuses a .zibel.json", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const placed = await call("zibel_svg_import", { docId, svg: exported, parentId: defaultLayerId });
  const { createdIds, nodes, warnings } = placed.structuredContent;
  const outline = (await call("zibel_doc_outline", { docId, rootId: defaultLayerId, depth: 1 }))
    .structuredContent.nodes;
  expect(outline).toMatchObject([
    { id: createdIds[0], type: "group", name: "Inkscape round trip" },
  ]);
  expect(nodes).toMatchObject([{ id: createdIds[0] }]);
  expect(nodes[0].children.map((n: { name: string; type: string }) => [n.type, n.name])).toEqual([
    ["group", "Layer 1"],
    ["group", "Guides"],
    ["group", "Painted"],
    ["group", "Transformed"],
  ]);
  // The fixture's one missing link; its other Images are embedded.
  expect(warnings).toMatchObject([{ code: "IMAGE_LINK_MISSING" }]);
  // The export's z-<id> ids are not reused.
  expect(createdIds.filter((id: string) => exported.includes(`z-${id}`))).toEqual([]);

  const file = (await call("zibel_export", { docId, format: "zibel_json" })).content[0].text;
  // Container Appearance comes along, on the Layer that became a Group too (ADR-0043).
  const named = (name: string) =>
    JSON.parse(file).nodes.find((n: { name: string }) => n.name === name);
  expect(named("Painted")).toMatchObject({
    type: "group",
    appearance: { contents: 0, strokes: [{ color: "#222222" }] },
  });
  expect(named("Outlined").appearance).toMatchObject({ contents: 1, strokes: [{ width: 8 }] });
  const refused = await call("zibel_svg_import", { docId, svg: file, parentId: defaultLayerId });
  expect(errorOf(refused)).toMatchObject({ code: "INVALID_DOCUMENT", path: "svg" });
  const text = await call("zibel_svg_import", { docId, svg: "nope", parentId: defaultLayerId });
  expect(errorOf(text)).toMatchObject({ code: "INVALID_DOCUMENT", path: "svg" });
  expect(errorOf(text).hint).not.toContain(".zibel.json file");
  const big = `<svg xmlns="http://www.w3.org/2000/svg"><desc>${"x".repeat(5 * 1024 * 1024)}</desc></svg>`;
  const huge = errorOf(
    await call("zibel_svg_import", { docId, svg: big, parentId: defaultLayerId }),
  );
  expect(huge).toMatchObject({ code: "LIMIT_EXCEEDED", path: "svg" });
  expect(huge.message).not.toContain("Open");

  // Staged in a Transaction: invisible to the committed rev until commit.
  const { txId, rev } = (await call("zibel_tx_begin", { docId })).structuredContent;
  const staged = await call("zibel_svg_import", {
    docId,
    txId,
    svg: exported,
    parentId: defaultLayerId,
  });
  expect(staged.structuredContent.rev).toBe(rev);
  const committed = (await call("zibel_doc_outline", { docId, rootId: defaultLayerId, depth: 1 }))
    .structuredContent.nodes;
  expect(committed).toHaveLength(1);
  await call("zibel_tx_commit", { docId, txId });
  const after = (await call("zibel_doc_outline", { docId, rootId: defaultLayerId, depth: 1 }))
    .structuredContent.nodes;
  expect(after.at(-1)?.id).toBe(staged.structuredContent.createdIds[0]);
});
