import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { imageId, readImage } from "@kalamo/core";
import { parseFile } from "@kalamo/io";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLUE_1x1_PNG, RED_2x2_PNG, WEBP_LOSSY_4x3 } from "../../../fixtures/images.ts";
import { imageKey } from "../src/document-object.ts";

const stub = (docId: string) => env.DOCUMENT.get(env.DOCUMENT.idFromName(docId));
type Stub = ReturnType<typeof stub>;

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
const blueId = () => imageId(readImage(BLUE_1x1_PNG, "src").bytes);

/** The ids of the Document's file rows and of its R2 objects, each sorted. */
async function stored(docId: string) {
  const rows = await runInDurableObject(stub(docId), (_, state) =>
    state.storage.sql
      .exec<{ id: string }>("SELECT id FROM images ORDER BY id")
      .toArray()
      .map((r) => r.id),
  );
  const prefix = imageKey(docId, "");
  const { objects } = await env.IMAGES.list({ prefix });
  return { rows, objects: objects.map((o) => o.key.slice(prefix.length)).sort() };
}

/** The object's bytes as base64, which compares a large file exactly and fast. */
const objectOf = async (docId: string, id: string) => {
  const object = await env.IMAGES.get(imageKey(docId, id));
  return object && new Uint8Array(await object.arrayBuffer()).toBase64();
};

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
  expect(await stored("images-store")).toEqual({ rows: [id], objects: [id] });
  expect(await objectOf("images-store", id)).toBe(RED_2x2_PNG.split(",")[1]);
  expect(ok(await s.svg("agent", {})).svg).toContain(`xlink:href="${RED_2x2_PNG}"`);
  expect(JSON.parse(ok(await s.file("agent")).text).images).toEqual({ [id]: RED_2x2_PNG });
  expect(ok(await s.raster("agent", { scale: 1 }, true)).svg).toContain(RED_2x2_PNG);
});

// The Worker converts a WebP before the Document Durable Object sees it (ADR-0100); one that
// reaches it as it is, say over the WebSocket, is refused and never stored.
it("refuses a raw WebP with the reason, and with partial keeps the other items", async () => {
  const { s, image } = await setup("images-refuse");
  const { rev } = ok(await s.info());
  const refused = await s.createNodes([image(WEBP_LOSSY_4x3)], "agent");
  expect(refused).toMatchObject({
    error: {
      code: "INVALID_IMAGE",
      path: "nodes[0].src",
      message: expect.stringContaining("no Kalamo file holds"),
    },
  });
  expect(ok(await s.info()).rev).toBe(rev);
  const bad = { type: "rect", parentId: "nope", x: 0, y: 0, width: 1, height: 1 } as const;
  const receipt = ok(
    await s.createNodes(
      [image(RED_2x2_PNG), image(WEBP_LOSSY_4x3), bad, image(RED_2x2_PNG, { x: 5 })],
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

it("keeps a file over 1 MiB whole in R2", async () => {
  const { s, image } = await setup("images-big");
  const big = new Uint8Array(1.5 * 1024 * 1024);
  big.set(readImage(RED_2x2_PNG, "src").bytes);
  const receipt = ok(await s.createNodes([image(`data:image/png;base64,${big.toBase64()}`)], "a"));
  const id = await imageId(big);
  expect(ok(await s.get(receipt.createdIds, "full", "a")).nodes[0]).toMatchObject({ src: id });
  expect(await objectOf("images-big", id)).toBe(big.toBase64());
});

it("refuses an id the Document does not hold", async () => {
  const { s, image } = await setup("images-unknown");
  expect(await s.createNodes([image("b".repeat(64))], "a")).toMatchObject({
    error: { code: "INVALID_IMAGE", path: "nodes[0].src" },
  });
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
    expect(svg).toContain(`xlink:href="photos/red.png" kalamo:src="${id}" id="z-${linked}"`);
    expect(svg).toContain(`xlink:href="gone.png" id="z-${missing}"`);
    expect(svg).not.toContain("data:");
    const raster = ok(await s.raster("agent", { scale: 1 }, true)).svg;
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

describe("Relink and Embed through node_update (ADR-0042)", () => {
  it("Relinks an embedded Image by data URL, keeping everything but its pixels; undo and redo restore it", async () => {
    const { s, image } = await setup("images-relink");
    const extra = { width: 40, height: 20, preserveAspectRatio: "xMidYMid slice", name: "Photo" };
    const { createdIds } = ok(await s.createNodes([image(RED_2x2_PNG, extra)], "agent"));
    const [nodeId] = createdIds as [string];
    ok(await s.updateNodes([{ nodeId, patch: { opacity: 0.5 } }], "agent"));
    ok(await s.transformNodes({ nodeIds: [nodeId], rotate: 30 }, "agent"));
    const [before] = ok(await s.get([nodeId], "full", "agent")).nodes;

    ok(await s.updateNodes([{ nodeId, patch: { src: BLUE_1x1_PNG } }], "agent"));
    const [after] = ok(await s.get([nodeId], "full", "agent")).nodes;
    expect(after).toEqual({ ...before, src: await blueId() });
    expect(ok(await s.raster("agent", { scale: 1 }, true)).svg).toContain(BLUE_1x1_PNG);

    ok(await s.undo("agent"));
    expect(ok(await s.get([nodeId], "full", "agent")).nodes[0]).toEqual(before);
    ok(await s.redo("agent"));
    expect(ok(await s.get([nodeId], "full", "agent")).nodes[0]).toEqual(after);
  });

  it("Relinks a missing link by id and file, and a new preserveAspectRatio in the same patch lands", async () => {
    const { s, image } = await setup("images-relink-missing");
    ok(await s.createNodes([image(BLUE_1x1_PNG)], "agent"));
    const missing = { ...image("", { file: "gone.png", width: 40, height: 20 }), src: undefined };
    const [nodeId] = ok(await s.createNodes([missing], "agent")).createdIds as [string];
    const patch = { src: await blueId(), file: "found.png", preserveAspectRatio: "xMidYMid meet" };
    ok(await s.updateNodes([{ nodeId, patch }], "agent"));
    expect(ok(await s.get([nodeId], "full", "agent")).nodes[0]).toMatchObject({
      ...patch,
      width: 40,
      height: 20,
    });
  });

  it("links an embedded Image with file, and Embeds a linked one with file: null; undo and redo restore it", async () => {
    const { s, image } = await setup("images-embed");
    const [nodeId] = ok(await s.createNodes([image(RED_2x2_PNG)], "agent")).createdIds as [string];
    ok(await s.updateNodes([{ nodeId, patch: { file: "photos/red.png" } }], "agent"));
    const [linked] = ok(await s.get([nodeId], "full", "agent")).nodes;
    expect(linked).toMatchObject({ src: await redId(), file: "photos/red.png" });

    ok(await s.updateNodes([{ nodeId, patch: { file: null } }], "agent"));
    const [embedded] = ok(await s.get([nodeId], "full", "agent")).nodes;
    expect(embedded).not.toHaveProperty("file");
    expect({ ...embedded, file: "photos/red.png" }).toEqual(linked);
    expect(ok(await s.svg("agent", {})).svg).toContain(`xlink:href="${RED_2x2_PNG}"`);

    ok(await s.undo("agent"));
    expect(ok(await s.get([nodeId], "full", "agent")).nodes[0]).toEqual(linked);
    ok(await s.redo("agent"));
    expect(ok(await s.get([nodeId], "full", "agent")).nodes[0]).toEqual(embedded);
  });

  it("refuses to Embed a missing link unless the same patch sets src", async () => {
    const { s, image } = await setup("images-embed-missing");
    const missing = { ...image("", { file: "gone.png", width: 40, height: 20 }), src: undefined };
    const [nodeId] = ok(await s.createNodes([missing], "agent")).createdIds as [string];
    expect(await s.updateNodes([{ nodeId, patch: { file: null } }], "agent")).toMatchObject({
      error: {
        code: "INVALID_IMAGE",
        path: "updates[0].patch.file",
        hint: expect.stringContaining("src"),
      },
    });
    ok(await s.updateNodes([{ nodeId, patch: { file: null, src: RED_2x2_PNG } }], "agent"));
    const [node] = ok(await s.get([nodeId], "full", "agent")).nodes;
    expect(node).toMatchObject({ src: await redId(), width: 40, height: 20 });
    expect(node).not.toHaveProperty("file");
  });

  it.each([
    ["src: null", { src: null }, "INVALID_PATCH", "src"],
    ["a raw WebP", { src: WEBP_LOSSY_4x3 }, "INVALID_IMAGE", "src"],
    ["an id the Document does not hold", { src: "b".repeat(64) }, "INVALID_IMAGE", "src"],
    ["an empty file", { file: "" }, "INVALID_IMAGE", "file"],
    ["a data: URL as file", { file: RED_2x2_PNG }, "INVALID_IMAGE", "file"],
    ["a file over 2048 characters", { file: "a".repeat(2049) }, "INVALID_IMAGE", "file"],
  ])("refuses %s", async (label, patch, code, key) => {
    const { s, image } = await setup(`images-update-refuse ${label}`);
    const [nodeId] = ok(await s.createNodes([image(RED_2x2_PNG)], "agent")).createdIds as [string];
    const { rev } = ok(await s.info());
    expect(await s.updateNodes([{ nodeId, patch }], "agent")).toMatchObject({
      error: { code, path: `updates[0].patch.${key}` },
    });
    expect(ok(await s.info()).rev).toBe(rev);
  });

  it("with partial, a refused file fails alone under its own index", async () => {
    const { s, image } = await setup("images-update-partial");
    const { createdIds } = ok(await s.createNodes([image(RED_2x2_PNG), image(RED_2x2_PNG)], "a"));
    const [a, b] = createdIds as [string, string];
    const receipt = ok(
      await s.updateNodes(
        [
          { nodeId: a, patch: { src: WEBP_LOSSY_4x3 } },
          { nodeId: b, patch: { src: BLUE_1x1_PNG } },
          { nodeId: "nope", patch: {} },
        ],
        "a",
        { partial: true },
      ),
    );
    expect(receipt.updatedIds).toEqual([b]);
    expect(receipt.failed).toMatchObject([
      { index: 0, code: "INVALID_IMAGE", path: "updates[0].patch.src" },
      { index: 2, code: "NODE_NOT_FOUND", path: "updates[2].nodeId" },
    ]);
  });
});

describe("image files in R2, swept once nothing names them (ADR-0046)", () => {
  afterEach(() => vi.useRealTimers());

  /** Ends a Transaction that staged a rect, which has the alarm sweep, and runs the alarm. */
  async function sweep(s: Stub, parentId: string) {
    const { txId } = ok(await s.begin("agent"));
    const rect = { type: "rect", parentId, x: 0, y: 0, width: 1, height: 1 } as const;
    ok(await s.createNodes([rect], "agent", { txId }));
    ok(await s.rollback(txId, "agent"));
    expect(await runDurableObjectAlarm(s)).toBe(true);
  }

  it("a refused create, Place or place-image leaves no row and no object (#66)", async () => {
    const { s, image, parentId } = await setup("r2-refused");
    const bad = { parentId: "nope" };
    expect(await s.createNodes([image(BLUE_1x1_PNG, bad)], "agent")).toMatchObject({
      error: { code: "NODE_NOT_FOUND" },
    });
    const blue = readImage(BLUE_1x1_PNG, "src");
    expect(await s.placeImage({ ...blue, name: "Image" }, "user", bad)).toMatchObject({
      error: { code: "NODE_NOT_FOUND" },
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image width="1" height="1" xlink:href="${BLUE_1x1_PNG}"/></svg>`;
    expect(await s.place(parseFile(svg), "user", bad)).toMatchObject({
      error: { code: "NODE_NOT_FOUND" },
    });
    const { rev } = ok(await s.info());
    expect(await s.createNodes([image(BLUE_1x1_PNG)], "agent", { ifRev: rev - 1 })).toMatchObject({
      error: { code: "REV_CONFLICT" },
    });
    const rect = { type: "rect", parentId, x: 0, y: 0, width: 1, height: 1 } as const;
    ok(await s.createNodes([image(BLUE_1x1_PNG, bad), rect], "agent", { partial: true }));
    expect((await stored("r2-refused")).rows).toEqual([]);
    // The failed item's upload is an orphan, swept once it is an hour old.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60 * 60_000 + 1000);
    expect(await runDurableObjectAlarm(s)).toBe(true);
    expect(await stored("r2-refused")).toEqual({ rows: [], objects: [] });
    ok(await s.createNodes([image(BLUE_1x1_PNG)], "agent"));
    expect(await stored("r2-refused")).toEqual({
      rows: [await blueId()],
      objects: [await blueId()],
    });
    expect(parentId).toBeTruthy();
  });

  it("keeps a deleted Image's file while undo or redo can bring it back, and sweeps it after", async () => {
    const { s, image, parentId } = await setup("r2-history");
    const id = await redId();
    const [nodeId] = ok(await s.createNodes([image(RED_2x2_PNG)], "agent")).createdIds as [string];
    ok(await s.deleteNodes([nodeId], "agent"));
    await sweep(s, parentId);
    ok(await s.undo("agent"));
    expect(ok(await s.raster("agent", { scale: 1 }, true)).svg).toContain(RED_2x2_PNG);
    ok(await s.redo("agent"));
    ok(await s.undo("agent"));
    ok(await s.deleteNodes([nodeId], "agent"));
    // The redo stack is cleared, but the undo stack still holds the delete and the create.
    await sweep(s, parentId);
    expect(await stored("r2-history")).toEqual({ rows: [id], objects: [id] });

    // Undoing the create too moves it to the redo stack, which the next edit clears.
    ok(await s.undo("agent"));
    ok(await s.undo("agent"));
    const rect = { type: "rect", parentId, x: 0, y: 0, width: 1, height: 1 } as const;
    ok(await s.createNodes([rect], "agent"));
    expect(await runDurableObjectAlarm(s)).toBe(true);
    expect(await stored("r2-history")).toEqual({ rows: [], objects: [] });
    const served = await exports.default.fetch(`http://kalamo/api/docs/r2-history/images/${id}`);
    expect(served.status).toBe(404);
    await served.body?.cancel();
    expect(await s.createNodes([image(id)], "agent")).toMatchObject({
      error: { code: "INVALID_IMAGE" },
    });
  });

  it("keeps a duplicated Image's file after its original is deleted and swept (ADR-0076)", async () => {
    const { s, image, parentId } = await setup("r2-duplicate");
    const id = await redId();
    const ids = ok(
      await s.createNodes([image(RED_2x2_PNG), image(RED_2x2_PNG, { file: "red.png" })], "agent"),
    ).createdIds;
    const { copies } = ok(await s.duplicateNodes({ nodeIds: ids }, "agent"));
    expect(await stored("r2-duplicate")).toEqual({ rows: [id], objects: [id] });
    ok(await s.deleteNodes(ids, "agent"));
    await sweep(s, parentId);
    expect(await stored("r2-duplicate")).toEqual({ rows: [id], objects: [id] });
    const copyIds = ids.map((n) => copies[n]?.[0] as string);
    const { nodes } = ok(await s.get(copyIds, "full", "agent"));
    expect(nodes).toMatchObject([{ src: id }, { src: id, file: "red.png" }]);
    const raster = ok(await s.raster("agent", { scale: 1, scope: { nodeIds: copyIds } }, true)).svg;
    expect(raster.split(`xlink:href="${RED_2x2_PNG}"`)).toHaveLength(3);
  });

  it("keeps an open Transaction's staged Image, drawn in its own render, and sweeps it after rollback or expiry", async () => {
    const { s, image, parentId } = await setup("r2-tx");
    const [red, blue] = [await redId(), await blueId()];
    const [kept] = ok(await s.createNodes([image(RED_2x2_PNG)], "agent")).createdIds as [string];
    vi.useFakeTimers({ toFake: ["Date"] });
    const rolled = ok(await s.begin("agent")).txId;
    ok(await s.createNodes([image(BLUE_1x1_PNG)], "agent", { txId: rolled }));
    ok(await s.deleteNodes([kept], "agent", { txId: rolled }));
    await sweep(s, parentId);
    expect(ok(await s.raster("agent", { scale: 1, txId: rolled }, true)).svg).toContain(
      BLUE_1x1_PNG,
    );
    expect(await stored("r2-tx")).toEqual({
      rows: [blue, red].sort(),
      objects: [blue, red].sort(),
    });
    ok(await s.rollback(rolled, "agent"));
    expect(await runDurableObjectAlarm(s)).toBe(true);
    expect(await stored("r2-tx")).toEqual({ rows: [red], objects: [red] });
    expect(ok(await s.raster("agent", { scale: 1 }, true)).svg).toContain(RED_2x2_PNG);

    const expiring = ok(await s.begin("agent")).txId;
    ok(await s.createNodes([image(BLUE_1x1_PNG)], "agent", { txId: expiring }));
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
    expect(await runDurableObjectAlarm(s)).toBe(true);
    expect(await stored("r2-tx")).toEqual({ rows: [red], objects: [red] });
  });

  it("sweeps an object with no row once it is an hour old, and sweeping twice changes nothing", async () => {
    const { s, image, parentId } = await setup("r2-orphan");
    const red = await redId();
    ok(await s.createNodes([image(RED_2x2_PNG)], "agent"));
    const orphan = "0".repeat(64);
    await env.IMAGES.put(imageKey("r2-orphan", orphan), new Uint8Array([1]));
    await sweep(s, parentId);
    expect(await stored("r2-orphan")).toEqual({ rows: [red], objects: [orphan, red] });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60 * 60_000 + 1000);
    // The sweep that kept it asked for another once it is an hour old.
    expect(await runDurableObjectAlarm(s)).toBe(true);
    expect(await stored("r2-orphan")).toEqual({ rows: [red], objects: [red] });
    await sweep(s, parentId);
    expect(await stored("r2-orphan")).toEqual({ rows: [red], objects: [red] });
  });

  it("writes its stored bytes to its documents row after a commit that stores a file and a sweep that frees one", async () => {
    const { s, image, parentId } = await setup("r2-report");
    await env.DB.prepare(
      "INSERT INTO documents (id, name, created_at, owner_id) VALUES ('r2-report', 'Doc', '', 'local')",
    ).run();
    const row = () =>
      env.DB.prepare("SELECT stored_bytes FROM documents WHERE id = 'r2-report'").first<number>(
        "stored_bytes",
      );
    const [nodeId] = ok(await s.createNodes([image(RED_2x2_PNG)], "agent")).createdIds as [string];
    expect(await row()).toBe(readImage(RED_2x2_PNG, "src").bytes.length);
    ok(await s.deleteNodes([nodeId], "agent"));
    // Undoing the create moves it to the redo stack, which the next edit clears.
    ok(await s.undo("agent"));
    ok(await s.undo("agent"));
    ok(await s.createNodes([{ type: "rect", parentId, x: 0, y: 0, width: 1, height: 1 }], "agent"));
    expect(await runDurableObjectAlarm(s)).toBe(true);
    expect(await row()).toBe(0);
  });

  it("refuses a file past what the owner's storage leaves, even under 20 MB, naming that limit", async () => {
    const { s, image } = await setup("r2-owner");
    const size = readImage(BLUE_1x1_PNG, "src").bytes.length;
    const storage = { used: 200 * 1024 * 1024 - size + 1, limit: 200 * 1024 * 1024 };
    expect(await s.createNodes([image(BLUE_1x1_PNG)], "agent", { storage })).toMatchObject({
      error: { code: "LIMIT_EXCEEDED", limit: { name: "storage", used: storage.used } },
    });
    expect(await stored("r2-owner")).toEqual({ rows: [], objects: [] });
    const roomy = { ...storage, used: storage.used - 1 };
    ok(await s.createNodes([image(BLUE_1x1_PNG)], "agent", { storage: roomy }));
  });

  describe("the 20 MB Document quota", () => {
    /** A distinct PNG of `size` bytes: a real header, then zeros. */
    const png = (n: number, size = 5 * 1024 * 1024) => {
      const bytes = new Uint8Array(size);
      bytes.set(readImage(RED_2x2_PNG, "src").bytes);
      bytes[size - 1] = n;
      return bytes;
    };
    const url = (bytes: Uint8Array) => `data:image/png;base64,${bytes.toBase64()}`;

    it("refuses a write that would store a new file past it, with nothing stored; a held file always passes", async () => {
      const { s, image, parentId } = await setup("r2-quota");
      for (let n = 0; n < 4; n++) ok(await s.createNodes([image(url(png(n)))], "agent"));
      expect(await s.storedImageBytes()).toBe(20 * 1024 * 1024);
      const { rev } = ok(await s.info());
      const refused = await s.createNodes([image(BLUE_1x1_PNG)], "agent");
      expect(refused).toMatchObject({
        error: {
          code: "LIMIT_EXCEEDED",
          message: `The Document stores ${20 * 1024 * 1024} bytes of image files; ${readImage(BLUE_1x1_PNG, "src").bytes.length} more would pass its limit of ${20 * 1024 * 1024} (20 MB).`,
          hint: expect.stringContaining("undo history"),
          limit: { name: "document_storage", limit: 20 * 1024 * 1024, used: 20 * 1024 * 1024 },
        },
      });
      expect(ok(await s.info()).rev).toBe(rev);
      expect((await stored("r2-quota")).objects).toHaveLength(4);
      expect(await objectOf("r2-quota", await blueId())).toBeNull();

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image width="1" height="1" xlink:href="${BLUE_1x1_PNG}"/></svg>`;
      expect(await s.place(parseFile(svg), "user", { parentId })).toMatchObject({
        error: { code: "LIMIT_EXCEEDED" },
      });
      expect(ok(await s.info()).rev).toBe(rev);
      expect(await objectOf("r2-quota", await blueId())).toBeNull();
      const held = await imageId(png(0));
      ok(await s.createNodes([image(held), image(url(png(1)))], "agent"));
      expect(await s.storedImageBytes()).toBe(20 * 1024 * 1024);
    }, 30_000);

    it("refuses to Open a file whose images pass it", async () => {
      const files = new Map(
        await Promise.all(
          [0, 1, 2, 3, 4].map(async (n) => {
            const bytes = png(n, n === 4 ? 1024 : undefined);
            return [await imageId(bytes), { ...readImage(url(bytes), "src") }] as const;
          }),
        ),
      );
      const opened = await stub("r2-open").open({
        docId: "r2-open",
        name: "Big",
        artboards: [],
        nodes: [],
        images: files,
        actor: "agent",
      });
      expect(opened).toMatchObject({ error: { code: "LIMIT_EXCEEDED" } });
      expect(await stub("r2-open").info()).toMatchObject({ error: { code: "DOC_NOT_FOUND" } });
      expect((await env.IMAGES.list({ prefix: imageKey("r2-open", "") })).objects).toEqual([]);
    }, 30_000);
  });

  describe("the legacy image upgrade (ADR-0023 to ADR-0046)", () => {
    /** Rewrites the Durable Object's file tables in the legacy shape: `images` without `size`, `bytes` in 2 chunks. */
    const seedLegacy = (s: Stub, id: string, bytes: Uint8Array) =>
      runInDurableObject(s, (_, state) => {
        const sql = state.storage.sql;
        sql.exec("DROP TABLE images");
        sql.exec(`CREATE TABLE images (
          id TEXT PRIMARY KEY, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL)`);
        sql.exec(`CREATE TABLE image_chunks (
          id TEXT NOT NULL, n INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (id, n))`);
        sql.exec("INSERT INTO images VALUES (?, 'image/png', 2, 2)", id);
        sql.exec("INSERT INTO image_chunks VALUES (?, 0, ?)", id, bytes.slice(0, 10).buffer);
        sql.exec("INSERT INTO image_chunks VALUES (?, 1, ?)", id, bytes.slice(10).buffer);
      });

    /** The rows of `image_chunks`, bytes as base64, or null once the table is gone. */
    const chunks = (s: Stub) =>
      runInDurableObject(s, (_, state) => {
        const sql = state.storage.sql;
        if (
          sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'image_chunks'").toArray().length === 0
        )
          return null;
        return sql
          .exec<{ id: string; n: number; bytes: ArrayBuffer }>(
            "SELECT * FROM image_chunks ORDER BY id, n",
          )
          .toArray()
          .map((r) => ({ id: r.id, n: r.n, bytes: new Uint8Array(r.bytes).toBase64() }));
      });

    /** Every row of the tables the upgrade must leave alone. */
    const untouched = (s: Stub) =>
      runInDurableObject(s, (_, state) =>
        ["doc", "nodes", "tx_log", "tx", "tx_nodes", "tx_delta", "history"].map((t) =>
          state.storage.sql.exec(`SELECT * FROM ${t} ORDER BY 1`).toArray(),
        ),
      );

    const addRow = (docId: string) =>
      env.DB.prepare(
        "INSERT INTO documents (id, name, created_at, owner_id, stored_bytes) VALUES (?, 'Doc', '', 'local', 0)",
      )
        .bind(docId)
        .run();

    const storedBytes = (docId: string) =>
      env.DB.prepare("SELECT stored_bytes FROM documents WHERE id = ?")
        .bind(docId)
        .first<number>("stored_bytes");

    it("moves a Document's files from SQLite chunks to R2 on its first request", async () => {
      const { s, image } = await setup("r2-legacy");
      const id = await redId();
      const bytes = readImage(RED_2x2_PNG, "src").bytes;
      await seedLegacy(s, id, bytes);
      await evictDurableObject(s);

      ok(await s.createNodes([image(id)], "agent"));
      expect(await objectOf("r2-legacy", id)).toBe(bytes.toBase64());
      expect(await s.storedImageBytes()).toBe(bytes.length);
      expect(ok(await s.svg("agent", {})).svg).toContain(RED_2x2_PNG);
      expect(await chunks(s)).toBeNull();
    });

    it("reports a live file's bytes to the Quota on the first open, and keeps every other table", async () => {
      const { s, image } = await setup("r2-legacy-live");
      await addRow("r2-legacy-live");
      const id = await redId();
      const bytes = readImage(RED_2x2_PNG, "src").bytes;
      ok(await s.createNodes([image(RED_2x2_PNG)], "agent"));
      await env.IMAGES.delete(imageKey("r2-legacy-live", id));
      await env.DB.prepare(
        "UPDATE documents SET stored_bytes = 0 WHERE id = 'r2-legacy-live'",
      ).run();
      await runInDurableObject(s, (_, state) => {
        state.storage.sql.exec(
          "INSERT INTO tx (id, actor, label, deadline) VALUES ('tx-open', 'agent', 'Open', 0)",
        );
        state.storage.sql.exec(
          "INSERT INTO tx_nodes (tx_id, node_id, working) VALUES ('tx-open', 'n1', '{}')",
        );
      });
      await seedLegacy(s, id, bytes);
      const before = await untouched(s);
      await evictDurableObject(s);

      expect(await s.storedImageBytes()).toBe(bytes.length);
      expect(await storedBytes("r2-legacy-live")).toBe(bytes.length);
      expect(await objectOf("r2-legacy-live", id)).toBe(bytes.toBase64());
      expect(await untouched(s)).toEqual(before);
      expect(await chunks(s)).toBeNull();
    });

    it("keeps chunks that no images row names, and the table with them", async () => {
      const { s } = await setup("r2-legacy-stray");
      const id = await redId();
      const bytes = readImage(RED_2x2_PNG, "src").bytes;
      await seedLegacy(s, id, bytes);
      await runInDurableObject(s, (_, state) => {
        state.storage.sql.exec("INSERT INTO image_chunks VALUES ('stray', 0, ?)", bytes.buffer);
      });
      await evictDurableObject(s);

      ok(await s.info());
      expect(await objectOf("r2-legacy-stray", id)).toBe(bytes.toBase64());
      expect(await chunks(s)).toEqual([{ id: "stray", n: 0, bytes: bytes.toBase64() }]);
    });

    it("counts a file that only undo history holds", async () => {
      const { s } = await setup("r2-legacy-held");
      await addRow("r2-legacy-held");
      const id = await redId();
      const bytes = readImage(RED_2x2_PNG, "src").bytes;
      await seedLegacy(s, id, bytes);
      await evictDurableObject(s);

      ok(await s.info());
      expect(await storedBytes("r2-legacy-held")).toBe(bytes.length);
      expect(await s.storedImageBytes()).toBe(bytes.length);
      expect(await objectOf("r2-legacy-held", id)).toBe(bytes.toBase64());
    });

    it("keeps the chunks of a Durable Object with no doc row, and finishes once the Document exists", async () => {
      const s = stub("r2-legacy-docless");
      const id = await redId();
      const bytes = readImage(RED_2x2_PNG, "src").bytes;
      const blue = readImage(BLUE_1x1_PNG, "src").bytes;
      await seedLegacy(s, id, bytes);
      const seeded = await chunks(s);
      await evictDurableObject(s);

      expect(await s.info()).toMatchObject({ error: { code: "DOC_NOT_FOUND" } });
      expect(await chunks(s)).toEqual(seeded);
      expect(seeded).toHaveLength(2);
      expect(await objectOf("r2-legacy-docless", id)).toBeNull();

      const { defaultLayerId: parentId } = ok(
        await s.create({ docId: "r2-legacy-docless", name: "Doc", artboards: [], actor: "a" }),
      );
      expect(await s.storedImageBytes()).toBe(bytes.length);
      await addRow("r2-legacy-docless");
      // A file written before the upgrade finishes goes to R2 as usual, and the upgrade leaves it be.
      ok(
        await s.createNodes([{ type: "image", parentId, src: BLUE_1x1_PNG, x: 0, y: 0 }], "agent"),
      );
      await evictDurableObject(s);

      ok(await s.info());
      expect(await objectOf("r2-legacy-docless", id)).toBe(bytes.toBase64());
      expect(await objectOf("r2-legacy-docless", await blueId())).toBe(blue.toBase64());
      expect(await storedBytes("r2-legacy-docless")).toBe(bytes.length + blue.length);
      expect(await s.storedImageBytes()).toBe(bytes.length + blue.length);
      expect(await chunks(s)).toBeNull();
    });
  });
});
