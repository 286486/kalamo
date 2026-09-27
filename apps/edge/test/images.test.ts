import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { imageId, readImage } from "@zibel/core";
import { parseFile } from "@zibel/io";
import { describe, expect, it } from "vitest";
import { RED_2x2_PNG, WEBP_HEADER } from "../../../fixtures/images.ts";

const stub = (docId: string) => env.DOCUMENT.get(env.DOCUMENT.idFromName(docId));

const ok = <T extends object>(result: T): Exclude<T, { error: unknown }> => {
  if ("error" in result) throw new Error(JSON.stringify(result.error));
  return result as Exclude<T, { error: unknown }>;
};

async function setup(docId: string) {
  const s = stub(docId);
  const { defaultLayerId: parentId } = ok(
    await s.create({ docId, name: "Doc", artboards: [{ width: 200, height: 100 }], actor: "a" }),
  );
  const image = (src: string, extra: object = {}) =>
    ({ type: "image", parentId, src, x: 0, y: 0, ...extra }) as const;
  return { s, image, parentId };
}

const redId = () => imageId(readImage(RED_2x2_PNG, "src").bytes);
const rows = (s: ReturnType<typeof stub>) =>
  runInDurableObject(s, (_, state) => ({
    images: state.storage.sql.exec("SELECT COUNT(*) AS n FROM images").one().n,
    chunks: state.storage.sql.exec("SELECT COUNT(*) AS n FROM image_chunks").one().n,
  }));

it("stores a data URL's file once and gives its Images the file's SHA-256 as src", async () => {
  const { s, image } = await setup("images-store");
  const id = await redId();
  const receipt = ok(
    await s.createNodes([image(RED_2x2_PNG), image(RED_2x2_PNG, { x: 5 })], "agent"),
  );
  ok(await s.createNodes([image(id, { x: 10 })], "agent"));
  const { nodes } = ok(await s.get(receipt.createdIds, "full", "agent"));
  expect(nodes).toMatchObject([
    { src: id, width: 2, height: 2 },
    { src: id, x: 5 },
  ]);
  expect(JSON.stringify(nodes)).not.toContain("data:");
  expect(await rows(s)).toEqual({ images: 1, chunks: 1 });
  expect(ok(await s.image(id)).bytes).toEqual(readImage(RED_2x2_PNG, "src").bytes);
  expect(ok(await s.svg("agent", {})).svg).toContain(`xlink:href="${RED_2x2_PNG}"`);
  expect(JSON.parse(ok(await s.file("agent")).text).images).toEqual({ [id]: RED_2x2_PNG });
  expect(ok(await s.raster("agent", { scale: 1 })).svg).toContain(RED_2x2_PNG);
});

it("refuses a WebP with the reason, and with partial keeps the other items", async () => {
  const { s, image } = await setup("images-refuse");
  const { rev } = ok(await s.info());
  const refused = await s.createNodes([image(WEBP_HEADER)], "agent");
  expect(refused).toMatchObject({
    error: { code: "INVALID_IMAGE", path: "nodes[0].src", hint: expect.stringContaining("PNG") },
  });
  expect(ok(await s.info()).rev).toBe(rev);
  const bad = { type: "rect", parentId: "nope", x: 0, y: 0, width: 1, height: 1 } as const;
  const receipt = ok(
    await s.createNodes(
      [image(RED_2x2_PNG), image(WEBP_HEADER), bad, image(RED_2x2_PNG, { x: 5 })],
      "agent",
      { partial: true },
    ),
  );
  expect(receipt.createdIds).toHaveLength(2);
  expect(receipt.failed).toMatchObject([
    { index: 1, code: "INVALID_IMAGE", path: "nodes[1].src" },
    { index: 2, code: "NODE_NOT_FOUND", path: "nodes[2].parentId" },
  ]);
});

it("keeps a file over 1 MiB in chunks and reads it back whole", async () => {
  const { s, image } = await setup("images-chunks");
  const big = new Uint8Array(1.5 * 1024 * 1024);
  big.set(readImage(RED_2x2_PNG, "src").bytes);
  const receipt = ok(await s.createNodes([image(`data:image/png;base64,${big.toBase64()}`)], "a"));
  const id = await imageId(big);
  expect(ok(await s.get(receipt.createdIds, "full", "a")).nodes[0]).toMatchObject({ src: id });
  expect(await rows(s)).toEqual({ images: 1, chunks: 2 });
  // Deep equality walks 1.5M elements one by one and times out on CI; base64 compares exactly.
  expect(ok(await s.image(id)).bytes.toBase64()).toBe(big.toBase64());
});

it("refuses an id the Document does not hold", async () => {
  const { s, image } = await setup("images-unknown");
  expect(await s.createNodes([image("b".repeat(64))], "a")).toMatchObject({
    error: { code: "INVALID_IMAGE", path: "nodes[0].src" },
  });
  expect(await s.image("b".repeat(64))).toMatchObject({ error: { code: "INVALID_IMAGE" } });
});

describe("linked Images (ADR-0042)", () => {
  it("creates a linked Image and a missing link; export writes the link, render the pixels or a crossed frame", async () => {
    const { s, image } = await setup("images-linked");
    const id = await redId();
    const receipt = ok(
      await s.createNodes(
        [
          image(RED_2x2_PNG, { file: "photos/red.png" }),
          { ...image("", { file: "gone.png", width: 40, height: 20 }), src: undefined },
        ],
        "agent",
      ),
    );
    const [linked, missing] = receipt.createdIds;
    const { nodes } = ok(await s.get(receipt.createdIds, "full", "agent"));
    expect(nodes[0]).toMatchObject({ src: id, file: "photos/red.png", width: 2, height: 2 });
    expect(nodes[1]).toMatchObject({ file: "gone.png", width: 40, height: 20 });
    expect(nodes[1]).not.toHaveProperty("src");
    expect(JSON.stringify(nodes)).not.toContain("data:");

    const { svg } = ok(await s.svg("agent", {}));
    expect(svg).toContain(`xlink:href="photos/red.png" zibel:src="${id}" id="z-${linked}"`);
    expect(svg).toContain(`xlink:href="gone.png" id="z-${missing}"`);
    expect(svg).not.toContain("data:");
    const raster = ok(await s.raster("agent", { scale: 1 })).svg;
    expect(raster).toContain(`xlink:href="${RED_2x2_PNG}"`);
    expect(raster).toContain(`<path d="M 0 0 L 40 0 L 40 20 L 0 20 Z M 0 0 L 40 20`);
    expect(raster).not.toContain("gone.png");

    const file = JSON.parse(ok(await s.file("agent")).text);
    expect(file.version).toBe(1);
    expect(file.images).toEqual({ [id]: RED_2x2_PNG });
    expect(file.nodes.find((n: { id: string }) => n.id === missing)).not.toHaveProperty("src");
  });

  it("pastes a copied linked Image with its pixels in the same Document, as a missing link in another", async () => {
    const { s, image, parentId } = await setup("images-paste-linked");
    const id = await redId();
    const { createdIds } = ok(
      await s.createNodes([image(RED_2x2_PNG, { file: "photos/red.png" })], "agent"),
    );
    const { svg } = ok(await s.svg("agent", { scope: { nodeIds: createdIds } }));
    const pasted = async ({ s: target, parentId }: Awaited<ReturnType<typeof setup>>) => {
      const receipt = ok(await target.place(parseFile(svg), "user", { parentId, inPlace: true }));
      const { nodes } = ok(await target.get(receipt.createdIds, "full", "user"));
      return { receipt, image: nodes.find((n) => n.type === "image") };
    };

    const same = await pasted({ s, image, parentId });
    expect(same.image).toMatchObject({ src: id, file: "photos/red.png", width: 2, height: 2 });
    expect(same.receipt.warnings).toEqual([]);

    const other = await pasted(await setup("images-paste-linked-other"));
    expect(other.image).toMatchObject({ file: "photos/red.png", width: 2, height: 2 });
    expect(other.image).not.toHaveProperty("src");
    expect(other.receipt.warnings).toEqual([
      expect.objectContaining({ code: "IMAGE_LINK_MISSING" }),
    ]);
  });

  it.each([
    ["an empty file", ""],
    ["a data: URL as file", RED_2x2_PNG],
    ["a file over 2048 characters", "a".repeat(2049)],
  ])("refuses %s with INVALID_IMAGE", async (label, file) => {
    const { s, image } = await setup(`images-linked ${label}`);
    const missing = { ...image("", { file, width: 4, height: 2 }), src: undefined };
    expect(await s.createNodes([missing], "agent")).toMatchObject({
      error: { code: "INVALID_IMAGE", path: "nodes[0].file" },
    });
  });
});
