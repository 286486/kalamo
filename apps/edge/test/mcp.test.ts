import { evictAllDurableObjects } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { type ErrorCode, formatPath, type ShapeNode, shapeSegments } from "@zibel/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import exported from "../../../fixtures/documents/inkscape.svg?raw";
import { BLUE_1x1_PNG, RED_2x2_PNG, WEBP_HEADER } from "../../../fixtures/images.ts";
import { decodePng } from "../../../fixtures/png.ts";
import { counted, fullZibelFile, MiB } from "./bodies.ts";
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

it("parses a tools/call without arguments as {}, answering INVALID_INPUT, not the SDK's text (#126)", async () => {
  const { body } = await rpc("tools/call", { name: "zibel_node_query" });
  expect(errorOf(body.result)).toEqual({
    code: "INVALID_INPUT",
    message: "zibel_node_query needs docId.",
    hint: "docId is required.",
    path: "docId",
  });
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

it("places and opens Illustrator's painted <use> Clip Group as one Clipping Mask, rendered as Illustrator draws it (ADR-0056)", async () => {
  const illustrator = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100">
    <g><defs><rect id="SVGID_1_" x="20" y="20" width="50" height="40"/></defs>
    <use xlink:href="#SVGID_1_" style="overflow:visible;fill:#00FF00;"/>
    <clipPath id="SVGID_2_"><use xlink:href="#SVGID_1_" style="overflow:visible;"/></clipPath>
    <rect style="clip-path:url(#SVGID_2_);fill:#FF0000;" width="40" height="100"/>
    <use xlink:href="#SVGID_1_" style="overflow:visible;fill:none;stroke:#0000FF;stroke-width:4;stroke-miterlimit:10;"/></g></svg>`;
  const { docId, defaultLayerId } = await newDoc();
  const placed = await call("zibel_svg_import", {
    docId,
    svg: illustrator,
    parentId: defaultLayerId,
    // Where the Clipping Path's centre is in the file, so the file's coordinates stay.
    position: { x: 45, y: 40 },
  });
  expect(placed.structuredContent.warnings).toEqual([]);
  const rendered = await call("zibel_render", {
    docId,
    scope: { rect: { x: 0, y: 0, width: 100, height: 100 } },
    scale: 1,
    background: "#FFFFFF",
  });
  const image = rendered.content.find((c: { type: string }) => c.type === "image");
  const { width, data } = await decodePng(Uint8Array.fromBase64(image.data));
  const at = (x: number, y: number) => [
    ...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3),
  ];
  expect(at(30, 40)).toEqual([255, 0, 0]); // content inside the clip
  expect(at(10, 40)).toEqual([255, 255, 255]); // content outside it
  expect(at(55, 40)).toEqual([0, 255, 0]); // the Clipping Path's Fill, behind the content
  expect(at(71, 40)).toEqual([0, 0, 255]); // its Stroke's outer half, unclipped

  const opened = (await call("zibel_doc_open", { content: illustrator })).structuredContent;
  expect(opened.warnings).toEqual([]);
  const [layer] = opened.nodes;
  const [group] = (
    await call("zibel_doc_outline", { docId: opened.docId, rootId: layer.id, depth: 2 })
  ).structuredContent.nodes;
  // The Clipping Path's bounds, not the 40 × 100 content's.
  expect(group).toMatchObject({ type: "group", bounds: { x: 20, y: 20, width: 50, height: 40 } });
  expect(group.children).toHaveLength(2);
});

it("clips a Layer by its topmost child, clipping Nodes created in it later, and releases it by the Layer's id (ADR-0053)", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const red = { fills: [{ color: "#FF0000" }] };
  const { keyMap } = (
    await call("zibel_node_create", {
      docId,
      nodes: [
        { type: "layer", parentId: defaultLayerId, clientKey: "sub" },
        {
          type: "ellipse",
          parentId: defaultLayerId,
          clientKey: "clip",
          x: 20,
          y: 30,
          width: 40,
          height: 40,
          appearance: red,
        },
      ],
    })
  ).structuredContent;
  await call("zibel_node_create", {
    docId,
    nodes: [
      { type: "rect", parentId: keyMap.sub, x: 0, y: 0, width: 100, height: 100, appearance: red },
    ],
  });
  const made = await call("zibel_mask_make", { docId, layerId: defaultLayerId });
  expect(made.isError).toBeFalsy();
  expect(made.structuredContent).toMatchObject({ createdIds: [], updatedIds: [keyMap.clip] });
  const layer = (await call("zibel_doc_outline", { docId })).structuredContent.nodes[0];
  expect(layer).toMatchObject({
    id: defaultLayerId,
    bounds: { x: 20, y: 30, width: 40, height: 40 },
  });
  // Drawn after Make, above the Clipping Path, and still clipped.
  await call("zibel_node_create", {
    docId,
    nodes: [
      {
        type: "rect",
        parentId: defaultLayerId,
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        appearance: red,
      },
    ],
  });
  // A 1 pt square of the render, compared with one where nothing is drawn.
  const at = async (x: number, y: number, id = docId) =>
    (await call("zibel_render", { docId: id, scope: { rect: { x, y, width: 1, height: 1 } } }))
      .content[0].data;
  const empty = await at(40, 50, (await newDoc()).docId);
  expect(await at(40, 50)).not.toBe(empty);
  expect(await at(150, 50)).toBe(empty);

  const released = await call("zibel_mask_release", { docId, nodeIds: [defaultLayerId] });
  expect(released.structuredContent.updatedIds).toEqual([keyMap.clip]);
  expect(await at(150, 50)).not.toBe(empty);
});

it("refuses layerId given with clipNodeId as INVALID_INPUT, and each Make on a Layer it cannot as INVALID_MASK", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const mixed = await call("zibel_mask_make", {
    docId,
    layerId: defaultLayerId,
    clipNodeId: defaultLayerId,
    contentIds: [defaultLayerId],
  });
  expect(errorOf(mixed)).toMatchObject({ code: "INVALID_INPUT" });
  const empty = await call("zibel_mask_make", { docId, layerId: defaultLayerId });
  expect(errorOf(empty)).toMatchObject({
    code: "INVALID_MASK",
    path: "layerId",
    hint: expect.stringMatching(/\S/),
  });
});

it("clips by a text, which stays editable: node_update changes the clip, and warns as any text (ADR-0052)", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const { keyMap } = (
    await call("zibel_node_create", {
      docId,
      nodes: [
        {
          type: "rect",
          parentId: defaultLayerId,
          clientKey: "art",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
        },
        {
          type: "text",
          parentId: defaultLayerId,
          clientKey: "t",
          x: 10,
          y: 60,
          content: "Hi",
          fontSize: 48,
          ranges: [{ start: 0, end: 1, fill: "#FF0000" }],
        },
      ],
    })
  ).structuredContent;
  const made = await call("zibel_mask_make", {
    docId,
    clipNodeId: keyMap.t,
    contentIds: [keyMap.art],
  });
  expect(made.isError).toBeFalsy();
  const [maskId] = made.structuredContent.createdIds;
  const get = async (id: string) =>
    (await call("zibel_node_get", { docId, nodeIds: [id], detail: "full" })).structuredContent
      .nodes[0];
  const text = await get(keyMap.t);
  expect(text).toMatchObject({ clipping: true, appearance: { fills: [], strokes: [] } });
  expect(text.ranges).toBeUndefined();
  expect((await get(maskId)).geometricBounds).toEqual(text.geometricBounds);

  const updated = (
    await call("zibel_node_update", {
      docId,
      updates: [{ nodeId: keyMap.t, patch: { content: "Hello", fontFamily: "Futura" } }],
    })
  ).structuredContent;
  expect(updated.warnings).toMatchObject([{ code: "FONT_MISSING", nodeId: keyMap.t }]);
  const edited = await get(keyMap.t);
  expect(edited.geometricBounds.width).toBeGreaterThan(text.geometricBounds.width);
  expect((await get(maskId)).geometricBounds).toEqual(edited.geometricBounds);
  const svg = (await call("zibel_export", { docId, format: "svg" })).content[0].text;
  expect(svg).toMatch(/<clipPath[^>]*><text[^>]*fill="none"[^>]*>.*Hello.*<\/text><\/clipPath>/);
  const rendered = await call("zibel_render", { docId, scope: { nodeIds: [maskId] }, scale: 1 });
  expect(rendered.structuredContent.viewport.docRect.width).toBeGreaterThan(
    text.geometricBounds.width,
  );

  await call("zibel_mask_release", { docId, nodeIds: [keyMap.t] });
  expect((await get(keyMap.t)).clipping).toBeUndefined();
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

it("writes a text with characters Source Sans 3 lacks and warns MISSING_GLYPHS naming them", async () => {
  const doc = await newDoc();
  const text = { type: "text", parentId: doc.defaultLayerId, x: 10, y: 50 };
  const created = await call("zibel_node_create", {
    docId: doc.docId,
    nodes: [{ ...text, content: "Hi 小动物" }],
  });
  const [id] = created.structuredContent.createdIds as string[];
  expect(created.structuredContent.warnings).toEqual([
    {
      code: "MISSING_GLYPHS",
      nodeId: id,
      message: expect.stringContaining("no glyphs for 小, 动, 物;"),
    },
  ]);
  const update = (content: string) =>
    call("zibel_node_update", { docId: doc.docId, updates: [{ nodeId: id, patch: { content } }] });
  expect((await update("Hi")).structuredContent.warnings).toEqual([]);
  expect((await update("你好")).structuredContent.warnings).toEqual([
    expect.objectContaining({ code: "MISSING_GLYPHS", nodeId: id }),
  ]);
  expect((await update("Hi")).structuredContent.warnings).toEqual([]);
  const other = await call("zibel_node_create", {
    docId: doc.docId,
    nodes: [{ ...text, content: "你好", fontFamily: "Noto Sans SC" }],
  });
  expect(other.structuredContent.warnings.map((w: { code: string }) => w.code)).toEqual([
    "FONT_MISSING",
    "MISSING_GLYPHS",
  ]);
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

it("creates a spiral, gets its parameters and derived d, and renders it (ADR-0060)", async () => {
  const doc = await newDoc();
  const spiral = {
    cx: 60,
    cy: 50,
    radius: 40,
    revolution: 2.5,
    expansion: 1.2,
    argument: 30,
    t0: 0.1,
  };
  const created = await call("zibel_node_create", {
    docId: doc.docId,
    nodes: [{ type: "spiral", parentId: doc.defaultLayerId, ...spiral }],
  });
  const [id] = created.structuredContent.createdIds as string[];
  const [full] = (await call("zibel_node_get", { docId: doc.docId, nodeIds: [id], detail: "full" }))
    .structuredContent.nodes;
  expect(full).toMatchObject({ type: "spiral", ...spiral, closed: false });
  expect(full.d).toBe(formatPath(shapeSegments(full as ShapeNode)));
  expect(full.d).not.toContain("Z");
  const rendered = await call("zibel_render", { docId: doc.docId, scope: { nodeIds: [id] } });
  expect(rendered.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  const update = (patch: object) =>
    call("zibel_node_update", { docId: doc.docId, updates: [{ nodeId: id, patch }] });
  expect(errorOf(await update({ t0: 1 }))).toMatchObject({
    code: "INVALID_INPUT",
    hint: expect.stringContaining("at most 0.999"),
  });
  expect(errorOf(await update({ turns: 4 }))).toMatchObject({ code: "INVALID_PATCH" });
  expect((await update({ revolution: 4, expansion: 0.5 })).isError).toBeFalsy();
  const [updated] = (
    await call("zibel_node_get", { docId: doc.docId, nodeIds: [id], detail: "full" })
  ).structuredContent.nodes;
  expect(updated).toMatchObject({ ...spiral, revolution: 4, expansion: 0.5 });
  expect(updated.d).toBe(formatPath(shapeSegments(updated as ShapeNode)));
  expect(updated.d).not.toBe(full.d);
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
  expect(JSON.parse(refused.content[0].text)).toMatchObject({
    code: "INVALID_INPUT",
    path: expect.stringMatching(/\.end$/),
  });
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

it("opens and places an SVG set in CJK with one MISSING_GLYPHS for the file", async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><text x="0" y="10">小动</text><text x="0" y="30">动物</text></svg>';
  const glyphs = [
    {
      code: "MISSING_GLYPHS",
      nodeId: expect.any(String),
      message: expect.stringContaining("no glyphs for 小, 动, 物;"),
    },
  ];
  expect((await call("zibel_doc_open", { content: svg })).structuredContent.warnings).toEqual(
    glyphs,
  );
  const { docId, defaultLayerId } = await newDoc();
  const placed = await call("zibel_svg_import", { docId, svg, parentId: defaultLayerId });
  expect(placed.structuredContent.warnings).toEqual(glyphs);
});

describe("a Place receipt's warnings name the placed Nodes (#161)", () => {
  type Warning = { code: string; nodeId?: string; message: string };
  const warned = (receipt: { structuredContent: { warnings: Warning[] } }, code: string) =>
    receipt.structuredContent.warnings.filter((w) => w.code === code);
  const texts = async (docId: string, ids: (string | undefined)[]) =>
    (await call("zibel_node_get", { docId, nodeIds: ids, detail: "full" })).structuredContent
      .nodes as { type: string; content: string; fontFamily: string }[];
  const HELVETICA =
    '<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="10" font-family="Helvetica">A</text></svg>';

  it("gives FONT_MISSING the placed Text's id, and keeps a warning without a nodeId", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const svg = HELVETICA.replace(
      "</svg>",
      '<pattern id="p"/><rect width="5" height="5" fill="url(#p)"/></svg>',
    );
    const placed = await call("zibel_svg_import", { docId, svg, parentId: defaultLayerId });
    const [font] = warned(placed, "FONT_MISSING");
    const outline = JSON.stringify(
      (await call("zibel_doc_outline", { docId, depth: 5 })).structuredContent,
    );
    expect(outline).toContain(`"${font?.nodeId}"`);
    expect(font?.nodeId).not.toBe(placed.structuredContent.createdIds[0]);
    expect(await texts(docId, [font?.nodeId])).toMatchObject([{ type: "text", content: "A" }]);
    expect(warned(placed, "UNSUPPORTED_PAINT")).toEqual([
      { code: "UNSUPPORTED_PAINT", message: expect.any(String) },
    ]);
  });

  it("gives two warned Texts two new ids, each on its own Text", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const svg = HELVETICA.replace(
      "</svg>",
      '<text x="0" y="30" font-family="Arial">B</text></svg>',
    );
    const placed = await call("zibel_svg_import", { docId, svg, parentId: defaultLayerId });
    const fonts = warned(placed, "FONT_MISSING");
    expect(new Set(fonts.map((w) => w.nodeId)).size).toBe(2);
    const got = await texts(
      docId,
      fonts.map((w) => w.nodeId),
    );
    expect(got.map((n) => n.content).sort()).toEqual(["A", "B"]);
    for (const [i, w] of fonts.entries()) expect(w.message).toContain(got[i]?.fontFamily);
  });

  it("drops a warning on a Clipping Path a Zibel copy leaves behind, keeping a listed Text's", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const text = { type: "text", parentId: defaultLayerId, fontFamily: "Helvetica" };
    const { keyMap } = (
      await call("zibel_node_create", {
        docId,
        nodes: [
          { ...text, clientKey: "clip", x: 0, y: 20, content: "Clip" },
          { ...text, clientKey: "kept", x: 0, y: 60, content: "Kept" },
          {
            type: "rect",
            clientKey: "art",
            parentId: defaultLayerId,
            x: 0,
            y: 0,
            width: 40,
            height: 40,
          },
        ],
      })
    ).structuredContent;
    await call("zibel_mask_make", { docId, clipNodeId: keyMap.clip, contentIds: [keyMap.art] });
    const svg = (
      await call("zibel_export", {
        docId,
        format: "svg",
        scope: { nodeIds: [keyMap.art, keyMap.kept] },
      })
    ).content[0].text;
    const pasted = await call("zibel_svg_import", { docId, svg, parentId: defaultLayerId });
    const fonts = warned(pasted, "FONT_MISSING");
    expect(fonts).toHaveLength(1);
    expect(pasted.structuredContent.createdIds).toContain(fonts[0]?.nodeId);
    expect(await texts(docId, [fonts[0]?.nodeId])).toMatchObject([{ content: "Kept" }]);
  });

  it("counts a Zibel copy's per-file text warnings over the Texts it places (#162)", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const copyOf = async (clip: object, kept: object) => {
      const text = { type: "text", parentId: defaultLayerId, x: 0 };
      const { keyMap } = (
        await call("zibel_node_create", {
          docId,
          nodes: [
            { ...text, ...clip, clientKey: "clip", y: 20 },
            { ...text, ...kept, clientKey: "kept", y: 60 },
            {
              type: "rect",
              clientKey: "art",
              parentId: defaultLayerId,
              x: 0,
              y: 0,
              width: 40,
              height: 40,
            },
          ],
        })
      ).structuredContent;
      await call("zibel_mask_make", { docId, clipNodeId: keyMap.clip, contentIds: [keyMap.art] });
      const scope = { nodeIds: [keyMap.art, keyMap.kept] };
      const svg = (await call("zibel_export", { docId, format: "svg", scope })).content[0].text;
      return call("zibel_svg_import", { docId, svg, parentId: defaultLayerId });
    };
    const clip = { fontFamily: "Helvetica", content: "小动" };

    const pasted = await copyOf(clip, { fontFamily: "Helvetica", content: "物" });
    const fonts = warned(pasted, "FONT_MISSING");
    const [glyphs] = warned(pasted, "MISSING_GLYPHS");
    expect(fonts).toHaveLength(1);
    expect(fonts[0]?.message).toMatch(/^Helvetica is/);
    expect(glyphs?.message).toContain("no glyphs for 物;");
    expect(glyphs?.nodeId).toBe(fonts[0]?.nodeId);
    expect(await texts(docId, [glyphs?.nodeId])).toMatchObject([{ content: "物" }]);

    const plain = await copyOf(clip, { content: "Kept" });
    expect(plain.structuredContent.warnings).toEqual([]);
  });

  it("gives doc_open's warnings, in order, to a full-file Place, on the placed Texts", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><text y="10" font-family="Helvetica">小动</text><text y="30" font-family="Arial">动物</text><text y="50" font-family="Helvetica">物</text></svg>';
    const opened = (await call("zibel_doc_open", { content: svg })).structuredContent.warnings;
    const { docId, defaultLayerId } = await newDoc();
    const placed = await call("zibel_svg_import", { docId, svg, parentId: defaultLayerId });
    const { warnings } = placed.structuredContent as { warnings: Warning[] };
    const bare = (ws: Warning[]) => ws.map(({ code, message }) => ({ code, message }));
    expect(bare(warnings)).toEqual(bare(opened));
    expect(warnings.map((w) => w.code)).toEqual(["FONT_MISSING", "FONT_MISSING", "MISSING_GLYPHS"]);
    const got = await texts(
      docId,
      warnings.map((w) => w.nodeId),
    );
    expect(got.map((n) => n.content)).toEqual(["小动", "动物", "小动"]);
  });

  it("leaves doc_open's warnings on the file's own ids", async () => {
    const opened = await call("zibel_doc_open", { content: HELVETICA });
    const [font] = warned(opened, "FONT_MISSING");
    const outline = JSON.stringify(
      (await call("zibel_doc_outline", { docId: opened.structuredContent.docId, depth: 5 }))
        .structuredContent,
    );
    expect(outline).toContain(`"${font?.nodeId}"`);
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
    // A clipped Layer arrives as a Clip Group (ADR-0053).
    ["group", "Clipped layer"],
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

describe("request body capped before the SDK reads it (ADR-0049)", () => {
  const post = (body: ReadableStream, length?: number, token: string | null = "dev-token-a") =>
    exports.default.fetch("http://zibel/mcp", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token && { authorization: `Bearer ${token}` }),
        ...(length !== undefined && { "content-length": String(length) }),
      },
    });
  const expectRefusal = async (res: Response) => {
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, data: { code: "LIMIT_EXCEEDED" } },
    });
  };

  it("refuses a declared length over 32 MiB without pulling the body", async () => {
    const { stream, pulls } = counted(33);
    await expectRefusal(await post(stream, 32 * MiB + 1));
    // The runtime pulls one chunk as it hands the request over, whether the Worker reads it or not.
    expect(pulls()).toBeLessThanOrEqual(1);
  });

  it("refuses a body that streams past 32 MiB, with no or an understated length, before its end", async () => {
    for (const length of [undefined, 10]) {
      const { stream, pulls } = counted(36);
      await expectRefusal(await post(stream, length));
      expect(pulls()).toBeLessThan(36);
    }
  }, 30_000);

  it("refuses a request without a token before reading its body", async () => {
    const { stream, pulls } = counted(36);
    const res = await post(stream, undefined, null);
    expect(res.status).toBe(401);
    await res.body?.cancel();
    expect(pulls()).toBeLessThanOrEqual(1);
  });

  it("opens a .zibel.json whose images fill the 20 MB Document cap", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const content = await fullZibelFile(docId, defaultLayerId);
    const opened = await call("zibel_doc_open", { content });
    expect(opened.isError).toBeFalsy();
    expect(opened.structuredContent).toMatchObject({ docId: expect.any(String) });
  }, 60_000);
});
