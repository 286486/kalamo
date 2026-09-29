import { createDocument, createNodes } from "@kalamo/core";
import { expect, it, vi } from "vitest";
import { imageCache } from "./images.ts";

function scene() {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const [a, b] = ["a".repeat(64), "b".repeat(64)];
  for (const id of [a, b]) doc.images.set(id, { mime: "image/png", width: 2, height: 2 });
  const image = (src: string, x: number) => ({ type: "image", parentId, src, x, y: 0 }) as const;
  createNodes(doc, [image(a, 0), image(a, 5), image(b, 10)]);
  return { doc, a, b, parentId };
}

const io = () => ({
  fetch: vi.fn(async (url: string) => new Response(new Blob([url], { type: "image/png" }))),
  decode: vi.fn(async (blob: Blob) => ({
    image: `bitmap of ${await blob.text()}`,
    width: 2,
    height: 2,
  })),
  read: vi.fn(async (blob: Blob) => `data:${blob.type};base64,${btoa(await blob.text())}`),
});

it("fetches each file once however many Images name it, and redraws as each arrives", async () => {
  const { doc, a, b } = scene();
  const deps = io();
  const onLoad = vi.fn();
  const cache = imageCache("D", onLoad, deps);
  expect(cache.get(a)).toBeUndefined();
  cache.want(doc);
  cache.want(doc);
  await cache.ready(doc);
  expect(deps.fetch.mock.calls.map(([url]) => url).sort()).toEqual([
    `/api/docs/D/images/${a}`,
    `/api/docs/D/images/${b}`,
  ]);
  expect(onLoad).toHaveBeenCalledTimes(2);
  expect(cache.get(a)).toEqual({
    image: `bitmap of /api/docs/D/images/${a}`,
    width: 2,
    height: 2,
    dataUrl: `data:image/png;base64,${btoa(`/api/docs/D/images/${a}`)}`,
  });
});

it("tries a file again after a failed fetch", async () => {
  const { doc, a } = scene();
  const deps = io();
  deps.fetch.mockResolvedValueOnce(new Response("gone", { status: 404 }));
  const cache = imageCache("D", () => {}, deps);
  await expect(cache.ready(doc)).rejects.toThrow("404");
  await cache.ready(doc);
  expect(cache.get(a)).toBeDefined();
});

it("does not fetch a failed file again on every redraw", async () => {
  const { doc, a } = scene();
  const deps = io();
  deps.fetch.mockResolvedValue(new Response("gone", { status: 404 }));
  const cache = imageCache("D", () => {}, deps);
  cache.want(doc);
  await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalledTimes(2));
  await new Promise((r) => setTimeout(r, 0));
  cache.want(doc);
  expect(deps.fetch).toHaveBeenCalledTimes(2);
  deps.fetch.mockImplementation(async (url: string) => new Response(new Blob([url])));
  await cache.ready(doc);
  expect(cache.get(a)).toBeDefined();
});

it("fetches only the files some Image's src names, not a missing link", async () => {
  const { doc, parentId } = scene();
  createNodes(doc, [
    { type: "image", parentId, file: "gone.png", x: 0, y: 0, width: 4, height: 4 },
  ]);
  const deps = io();
  const cache = imageCache("D", () => {}, deps);
  cache.want(doc);
  await cache.ready(doc);
  expect(deps.fetch).toHaveBeenCalledTimes(2);
});
