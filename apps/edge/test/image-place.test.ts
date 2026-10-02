import { readImage } from "@kalamo/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  RED_2x2_PNG,
  WEBP_4x3_RGBA,
  WEBP_ANIMATED,
  WEBP_LOSSLESS_4x3,
  WEBP_OVER_CAP,
} from "../../../fixtures/images.ts";
import { call, errorOf } from "./rpc.ts";
import { servedPng } from "./served.ts";

const newDoc = async () =>
  (await call("kalamo_doc_create", { name: "Doc", artboards: [{ width: 200, height: 100 }] }))
    .structuredContent as { docId: string; defaultLayerId: string };

it("places a data URL centred on the parent's Artboard, and never echoes the bytes", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const placed = await call("kalamo_image_place", {
    docId,
    src: RED_2x2_PNG,
    parentId: defaultLayerId,
  });
  expect(placed.isError).toBeFalsy();
  const { createdIds } = placed.structuredContent;
  expect(createdIds).toHaveLength(1);
  const got = await call("kalamo_node_get", { docId, nodeIds: createdIds, detail: "full" });
  expect(got.structuredContent.nodes).toMatchObject([
    {
      type: "image",
      x: 99,
      y: 49,
      width: 2,
      height: 2,
      src: expect.stringMatching(/^[0-9a-f]{64}$/),
    },
  ]);
  expect(JSON.stringify([placed, got])).not.toContain("data:");
});

it("asTemplate puts it at 50% on a locked Template Layer beneath the parent's Layer", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const placed = await call("kalamo_image_place", {
    docId,
    src: RED_2x2_PNG,
    parentId: defaultLayerId,
    asTemplate: true,
  });
  const [layerId, imageId] = placed.structuredContent.createdIds;
  const outline = await call("kalamo_doc_outline", { docId, depth: 1 });
  expect(outline.structuredContent.nodes).toMatchObject([
    { id: layerId, type: "layer", name: "Template Image", locked: true, childCount: 1 },
    { id: defaultLayerId },
  ]);
  const got = await call("kalamo_node_get", {
    docId,
    nodeIds: [layerId, imageId],
    detail: "full",
  });
  expect(got.structuredContent.nodes).toMatchObject([
    { type: "layer", template: true, locked: true },
    { type: "image", parentId: layerId, opacity: 0.5 },
  ]);
});

it.each(["file:///tmp/a.png", "/tmp/a.png"])(
  "refuses %s, since the server cannot read the Agent's disk",
  async (src) => {
    const { docId, defaultLayerId } = await newDoc();
    const result = await call("kalamo_image_place", { docId, src, parentId: defaultLayerId });
    expect(errorOf(result)).toMatchObject({
      code: "INVALID_IMAGE",
      path: "src",
      hint: expect.stringContaining("data:"),
    });
  },
);

const RED = readImage(RED_2x2_PNG, "src").bytes;
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
/**
 * Stubs the Worker's outbound fetch with one reply per call, in order. Each is built inside the
 * call: a body made in the test's context cannot be read from the Worker's request.
 */
const replies = (...rs: (() => Response | Error)[]) => {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const r of rs) {
    spy.mockImplementationOnce(async () => {
      const reply = r();
      if (reply instanceof Error) throw reply;
      return reply;
    });
  }
  return spy;
};
afterEach(() => vi.restoreAllMocks());

const placeUrl = async (src: string, extra: object = {}) => {
  const { docId, defaultLayerId } = await newDoc();
  const result = await call("kalamo_image_place", {
    docId,
    src,
    parentId: defaultLayerId,
    ...extra,
  });
  return { docId, result, error: errorOf(result) };
};

it("fetches a URL through a redirect, typing the file by its bytes, and names the Template Layer after it", async () => {
  const spy = replies(
    () => redirect("https://cdn.example/photos/red%20dot.png?v=2"),
    () => new Response(RED, { headers: { "content-type": "text/plain" } }),
  );
  const { docId, result, error } = await placeUrl("https://example.com/a", { asTemplate: true });
  expect(error).toBeNull();
  const [layerId, imageId] = result.structuredContent.createdIds;
  const got = await call("kalamo_node_get", { docId, nodeIds: [layerId, imageId], detail: "full" });
  expect(got.structuredContent.nodes).toMatchObject([
    { name: "Template red dot.png" },
    { type: "image", width: 2, height: 2 },
  ]);
  expect(spy.mock.calls.map(([url]) => String(url))).toEqual([
    "https://example.com/a",
    "https://cdn.example/photos/red%20dot.png?v=2",
  ]);
  for (const [, init] of spy.mock.calls) {
    expect(init).toMatchObject({ redirect: "manual", signal: expect.any(AbortSignal) });
  }
});

it("refuses a private address before fetching, and a redirect into one", async () => {
  const none = replies();
  expect((await placeUrl("http://127.0.0.1/a.png")).error).toMatchObject({
    code: "FETCH_FAILED",
    path: "src",
  });
  expect(none).not.toHaveBeenCalled();
  const once = replies(() => redirect("http://169.254.169.254/latest/meta-data"));
  expect((await placeUrl("https://example.com/a.png")).error).toMatchObject({
    code: "FETCH_FAILED",
    message: expect.stringContaining("169.254.169.254"),
  });
  expect(once).toHaveBeenCalledTimes(1);
});

it("fails FETCH_FAILED on a bad status, too many redirects, a network error and the timeout", async () => {
  replies(() => new Response("gone", { status: 404 }));
  expect((await placeUrl("https://example.com/a.png")).error).toMatchObject({
    code: "FETCH_FAILED",
    message: expect.stringContaining("404"),
  });
  replies(...Array.from({ length: 6 }, (_, i) => () => redirect(`https://example.com/${i}`)));
  expect((await placeUrl("https://example.com/a.png")).error).toMatchObject({
    code: "FETCH_FAILED",
    message: expect.stringContaining("redirect"),
  });
  replies(() => new Response(null, { status: 204 }));
  expect((await placeUrl("https://example.com/a.png")).error).toMatchObject({
    code: "FETCH_FAILED",
    message: expect.stringContaining("no body"),
  });
  replies(() => new TypeError("Network connection lost."));
  expect((await placeUrl("https://example.com/a.png")).error).toMatchObject({
    code: "FETCH_FAILED",
  });
  replies(() => new DOMException("The operation timed out.", "TimeoutError"));
  expect((await placeUrl("https://example.com/a.png")).error).toMatchObject({
    code: "FETCH_FAILED",
    message: expect.stringContaining("10 s"),
  });
});

it("stops reading past 20 MB, and a file past 5 MB or not an image fails the image checks", async () => {
  const cancel = vi.fn();
  const chunk = new Uint8Array(1024 * 1024);
  replies(
    () => new Response(new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(chunk), cancel })),
  );
  expect((await placeUrl("https://example.com/a.png")).error).toMatchObject({
    code: "LIMIT_EXCEEDED",
    message: expect.stringContaining("20 MB"),
  });
  expect(cancel).toHaveBeenCalled();

  const big = new Uint8Array(6 * 1024 * 1024);
  big.set(RED.subarray(0, 24));
  replies(() => new Response(big));
  expect((await placeUrl("https://example.com/a.png")).error).toMatchObject({
    code: "LIMIT_EXCEEDED",
    message: expect.stringContaining(String(big.length)),
  });

  replies(() => new Response("<svg/>"));
  expect((await placeUrl("https://example.com/a.png")).error).toMatchObject({
    code: "INVALID_IMAGE",
    path: "src",
  });
});

const webpBytes = (url: string) => Uint8Array.fromBase64(url.split(",")[1] ?? "");

it.each([
  ["URL", "https://example.com/photo.webp"],
  ["data URL", WEBP_LOSSLESS_4x3],
])("places a WebP from a %s as a PNG of its pixels (ADR-0100)", async (_, src) => {
  replies(
    () => new Response(webpBytes(WEBP_LOSSLESS_4x3), { headers: { "content-type": "image/png" } }),
  );
  const { docId, result, error } = await placeUrl(src);
  expect(error).toBeNull();
  const got = await call("kalamo_node_get", {
    docId,
    nodeIds: result.structuredContent.createdIds,
    detail: "full",
  });
  const [node] = got.structuredContent.nodes;
  expect(node).toMatchObject({ type: "image", width: 4, height: 3 });
  expect(await servedPng(docId, node.src)).toEqual(WEBP_4x3_RGBA);
});

it("refuses an animated WebP and one over the pixel cap, fetched or as a data URL", async () => {
  replies(() => new Response(webpBytes(WEBP_ANIMATED)));
  expect((await placeUrl("https://example.com/a.webp")).error).toMatchObject({
    code: "INVALID_IMAGE",
    hint: expect.stringContaining("one frame as PNG or GIF"),
    path: "src",
  });
  expect((await placeUrl(WEBP_OVER_CAP)).error).toMatchObject({
    code: "LIMIT_EXCEEDED",
    message: expect.stringContaining("4096 × 2049"),
    path: "src",
  });
});
