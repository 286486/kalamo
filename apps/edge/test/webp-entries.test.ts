import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  RED_2x2_PNG,
  WEBP_4x3_RGBA,
  WEBP_ALPHA_4x3,
  WEBP_ALPHA_4x3_RGBA,
  WEBP_ANIMATED,
  WEBP_CAP_LOSSLESS,
  WEBP_LOSSLESS_4x3,
  WEBP_LOSSY_4x3,
  WEBP_LOSSY_4x3_RGBA,
  WEBP_OVER_CAP,
  WEBP_TRUNCATED,
} from "../../../fixtures/images.ts";
import { imageKey } from "../src/document-object.ts";
import { call, errorOf } from "./rpc.ts";
import { servedPng } from "./served.ts";

// Every MCP entry that takes an image file takes a WebP and stores a PNG of its pixels (ADR-0100).

const newDoc = async () =>
  (await call("kalamo_doc_create", { name: "Doc", artboards: [{ width: 200, height: 100 }] }))
    .structuredContent as { docId: string; defaultLayerId: string };
const full = async (docId: string, nodeIds: string[]) =>
  (await call("kalamo_node_get", { docId, nodeIds, detail: "full" })).structuredContent.nodes;
/** The ids of the Document's objects in R2. */
const objects = async (docId: string) =>
  (await env.IMAGES.list({ prefix: imageKey(docId, "") })).objects.map((o) => o.key);
const storedBytes = (docId: string) =>
  env.DB.prepare("SELECT stored_bytes FROM documents WHERE id = ?")
    .bind(docId)
    .first<number>("stored_bytes");

describe("kalamo_node_create", () => {
  it.each([
    ["lossy", WEBP_LOSSY_4x3, WEBP_LOSSY_4x3_RGBA],
    ["lossless", WEBP_LOSSLESS_4x3, WEBP_4x3_RGBA],
    ["alpha", WEBP_ALPHA_4x3, WEBP_ALPHA_4x3_RGBA],
  ])("stores a %s WebP as a PNG of its pixels", async (_, src, rgba) => {
    const { docId, defaultLayerId } = await newDoc();
    const created = await call("kalamo_node_create", {
      docId,
      nodes: [{ type: "image", parentId: defaultLayerId, src, x: 0, y: 0 }],
    });
    expect(errorOf(created)).toBeNull();
    const [node] = await full(docId, created.structuredContent.createdIds);
    expect(node).toMatchObject({ type: "image", width: 4, height: 3 });
    expect(await servedPng(docId, node.src)).toEqual(rgba);
    const file = JSON.parse(
      (await call("kalamo_export", { docId, format: "kalamo_json" })).content[0].text,
    );
    expect(file.images[node.src]).toMatch(/^data:image\/png;base64,/);
  });

  it("converts a WebP inside inline children", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const image = { type: "image", src: WEBP_LOSSLESS_4x3, x: 0, y: 0 };
    const group = {
      type: "group",
      parentId: defaultLayerId,
      children: [{ type: "group", children: [image] }],
    };
    const created = await call("kalamo_node_create", { docId, nodes: [group] });
    expect(errorOf(created)).toBeNull();
    const ids = created.structuredContent.createdIds as string[];
    const node = (await full(docId, ids)).find((n: { type: string }) => n.type === "image");
    expect(await servedPng(docId, node.src)).toEqual(WEBP_4x3_RGBA);
  });

  it("fails a WebP it cannot convert under its own path; with partial, alone", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const image = (src: string) => ({ type: "image", src, x: 0, y: 0 });
    const nested = (src: string) => ({
      type: "group",
      parentId: defaultLayerId,
      children: [image(src)],
    });
    expect(
      errorOf(
        await call("kalamo_node_create", {
          docId,
          nodes: [nested(RED_2x2_PNG), nested(WEBP_ANIMATED)],
        }),
      ),
    ).toMatchObject({
      code: "INVALID_IMAGE",
      hint: expect.stringContaining("one frame as PNG or GIF"),
      path: "nodes[1].children[0].src",
    });
    const receipt = await call("kalamo_node_create", {
      docId,
      partial: true,
      nodes: [
        nested(WEBP_OVER_CAP),
        nested(WEBP_LOSSY_4x3),
        nested(WEBP_TRUNCATED),
        { type: "rect", parentId: "nope", x: 0, y: 0, width: 1, height: 1 },
      ],
    });
    expect(receipt.structuredContent.createdIds).toHaveLength(2);
    expect(receipt.structuredContent.failed).toMatchObject([
      { index: 0, code: "LIMIT_EXCEEDED", path: "nodes[0].children[0].src" },
      { index: 2, code: "INVALID_IMAGE", message: expect.stringContaining("damaged") },
      { index: 3, code: "NODE_NOT_FOUND" },
    ]);
  });

  it("gives the same WebP the same src every time, storing and counting one PNG", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const image = { type: "image", parentId: defaultLayerId, src: WEBP_ALPHA_4x3, x: 0, y: 0 };
    const first = await call("kalamo_node_create", { docId, nodes: [image, image] });
    const second = await call("kalamo_node_create", { docId, nodes: [image] });
    const placed = await call("kalamo_image_place", {
      docId,
      src: WEBP_ALPHA_4x3,
      parentId: defaultLayerId,
    });
    const ids = [first, second, placed].flatMap((r) => r.structuredContent.createdIds);
    const srcs = new Set<string>((await full(docId, ids)).map((n: { src: string }) => n.src));
    expect(srcs.size).toBe(1);
    const [src = ""] = srcs;
    expect(await objects(docId)).toEqual([imageKey(docId, src)]);
    const png = await env.IMAGES.get(imageKey(docId, src));
    expect(await storedBytes(docId)).toBe(png?.size);
    await png?.body.cancel();
  });
});

it("kalamo_node_update relinks to a WebP, and fails one it cannot convert", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const image = { type: "image", parentId: defaultLayerId, src: RED_2x2_PNG, x: 0, y: 0 };
  const [nodeId] = (await call("kalamo_node_create", { docId, nodes: [image] })).structuredContent
    .createdIds as string[];
  const relinked = await call("kalamo_node_update", {
    docId,
    updates: [{ nodeId, patch: { src: WEBP_LOSSLESS_4x3 } }],
  });
  expect(errorOf(relinked)).toBeNull();
  const [node] = await full(docId, [nodeId as string]);
  expect(await servedPng(docId, node.src)).toEqual(WEBP_4x3_RGBA);
  expect(
    errorOf(
      await call("kalamo_node_update", {
        docId,
        updates: [{ nodeId, patch: { src: WEBP_ANIMATED } }],
      }),
    ),
  ).toMatchObject({ code: "INVALID_IMAGE", path: "updates[0].patch.src" });
});

it("kalamo_image_place places a WebP at the 4096 × 2048 cap", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const placed = await call("kalamo_image_place", {
    docId,
    src: WEBP_CAP_LOSSLESS,
    parentId: defaultLayerId,
  });
  expect(errorOf(placed)).toBeNull();
  const [node] = await full(docId, placed.structuredContent.createdIds);
  expect(node).toMatchObject({ width: 4096, height: 2048 });
  const pixels = await servedPng(docId, node.src);
  expect(pixels.slice(0, 4)).toEqual([40, 90, 160, 255]);
}, 30_000);

describe("kalamo_doc_open", () => {
  it("opens a WebP data URL as a Document named without .webp", async () => {
    const opened = await call("kalamo_doc_open", { content: WEBP_ALPHA_4x3, name: "logo.webp" });
    expect(errorOf(opened)).toBeNull();
    const { docId, name } = opened.structuredContent;
    expect(name).toBe("logo");
    const file = JSON.parse(
      (await call("kalamo_export", { docId, format: "kalamo_json" })).content[0].text,
    );
    expect(file.artboards[0].frame).toEqual({ x: 0, y: 0, width: 4, height: 3 });
    const image = file.nodes.find((n: { type: string }) => n.type === "image");
    expect(await servedPng(docId, image.src)).toEqual(WEBP_ALPHA_4x3_RGBA);
  });

  it.each([
    [WEBP_ANIMATED, "INVALID_IMAGE"],
    [WEBP_OVER_CAP, "LIMIT_EXCEEDED"],
    [WEBP_TRUNCATED, "INVALID_IMAGE"],
  ])("refuses a WebP it cannot convert: %#", async (content, code) => {
    expect(errorOf(await call("kalamo_doc_open", { content }))).toMatchObject({
      code,
      path: "content",
    });
  });
});

describe("an SVG embedding WebP images", () => {
  const svg = (...hrefs: string[]) =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100">${hrefs
      .map((h, i) => `<image x="${i * 10}" xlink:href="${h}"/>`)
      .join("")}</svg>`;

  it("kalamo_doc_open keeps each as an Image of its PNG, and drops one it cannot convert", async () => {
    const opened = await call("kalamo_doc_open", {
      content: svg(WEBP_LOSSLESS_4x3, WEBP_ANIMATED, WEBP_LOSSLESS_4x3),
    });
    expect(errorOf(opened)).toBeNull();
    const { docId, warnings } = opened.structuredContent;
    expect(warnings).toEqual([
      { code: "INVALID_IMAGE", message: expect.stringContaining("The WebP is animated") },
    ]);
    const file = JSON.parse(
      (await call("kalamo_export", { docId, format: "kalamo_json" })).content[0].text,
    );
    const images = file.nodes.filter((n: { type: string }) => n.type === "image");
    expect(images).toHaveLength(2);
    expect(Object.keys(file.images)).toEqual([images[0].src]);
    expect(await servedPng(docId, images[0].src)).toEqual(WEBP_4x3_RGBA);
  });

  it("kalamo_svg_import does the same", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const placed = await call("kalamo_svg_import", {
      docId,
      svg: svg(WEBP_ALPHA_4x3, WEBP_OVER_CAP),
      parentId: defaultLayerId,
    });
    expect(errorOf(placed)).toBeNull();
    expect(placed.structuredContent.warnings).toEqual([
      { code: "INVALID_IMAGE", message: expect.stringContaining("4096 × 2049") },
    ]);
    const nodes = await full(docId, placed.structuredContent.createdIds);
    const image = nodes.find((n: { type: string }) => n.type === "image");
    expect(await servedPng(docId, image.src)).toEqual(WEBP_ALPHA_4x3_RGBA);
  });
});
