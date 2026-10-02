import { env, exports } from "cloudflare:workers";
import { imageId, type Rect, readImage } from "@kalamo/core";
import { describe, expect, it } from "vitest";
import {
  orientedJpeg,
  QUADRANT,
  QUADRANTS_8x4_JPEG,
  UPRIGHT_QUADRANTS,
  WEBP_ANIMATED,
} from "../../../fixtures/images.ts";
import { decodePng } from "../../../fixtures/png.ts";
import { imageKey } from "../src/document-object.ts";
import { call, errorOf } from "./rpc.ts";

// Every entry that takes an image file stores a JPEG's EXIF orientation as 1 and turns the Image
// upright with its transform, so render, the canvas and Inkscape agree (ADR-0101).

const ORIENTATIONS = [1, 2, 3, 4, 5, 6, 7, 8];
/** Orientation 6's offset of the IFD0 value in orientedJpeg's files. */
const VALUE = 42;

const newDoc = async () =>
  (await call("kalamo_doc_create", { name: "Doc", artboards: [{ width: 200, height: 100 }] }))
    .structuredContent as { docId: string; defaultLayerId: string };
const full = async (docId: string, nodeIds: string[]) =>
  (await call("kalamo_node_get", { docId, nodeIds, detail: "full" })).structuredContent.nodes;
const bytesOf = (url: string) => readImage(url, "src").bytes;
const ok = <T extends { isError?: boolean; content: { text: string }[] }>(result: T) => {
  expect(errorOf(result)).toBeNull();
  return result;
};
const kalamoJson = async (docId: string) =>
  (await call("kalamo_export", { docId, format: "kalamo_json" })).content[0].text as string;

/** The stored file's bytes, as the image route serves them. */
async function served(docId: string, src: string) {
  const res = await exports.default.fetch(`http://kalamo/api/docs/${docId}/images/${src}`);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

/** `input` with its orientation value 1, the only byte that should change. */
function upright(input: Uint8Array) {
  const want = input.slice();
  want[VALUE] = 1;
  return want;
}

const NAMES = Object.entries(QUADRANT);
/** The colours `render` draws at `points` in document coordinates, as UPRIGHT_QUADRANTS spells them. */
async function colours(docId: string, points: [number, number][], scope?: Rect) {
  const result = ok(
    await call("kalamo_render", { docId, scale: 4, ...(scope && { scope: { rect: scope } }) }),
  );
  const png = result.content.find((c: { type: string }) => c.type === "image");
  const { data, width } = await decodePng(Uint8Array.fromBase64(png.data));
  const { docRect, scale } = result.structuredContent.viewport;
  return points
    .map(([x, y]) => {
      const i =
        4 * (Math.floor((y - docRect.y) * scale) * width + Math.floor((x - docRect.x) * scale));
      const c = [...data.subarray(i, i + 3)];
      return NAMES.find(([, q]) => q.every((v, k) => Math.abs(v - (c[k] ?? 0)) < 40))?.[0] ?? "?";
    })
    .join("");
}
/** The colours at `box`'s quadrant centres: top left, top right, bottom left, bottom right. */
const quadrants = (docId: string, box: Rect) =>
  colours(
    docId,
    [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ].map(([fx = 0, fy = 0]) => [box.x + fx * box.width, box.y + fy * box.height]),
    box,
  );

describe("kalamo_node_create", () => {
  it.each(ORIENTATIONS)("places orientation %i upright, stored as orientation 1", async (o) => {
    const { docId, defaultLayerId } = await newDoc();
    const src = orientedJpeg(o);
    const box = { x: 100, y: 10, width: 24, height: 40 };
    const created = ok(
      await call("kalamo_node_create", {
        docId,
        nodes: [
          { type: "image", parentId: defaultLayerId, src, x: 10, y: 10 },
          { type: "image", parentId: defaultLayerId, src, ...box },
        ],
      }),
    );
    const size = o >= 5 ? { width: 4, height: 8 } : { width: 8, height: 4 };
    expect(created.structuredContent.bounds).toEqual({ x: 10, y: 10, width: 114, height: 40 });
    const [byDefault, boxed] = await full(docId, created.structuredContent.createdIds);
    expect(byDefault.geometricBounds).toEqual({ x: 10, y: 10, ...size });
    expect(boxed.geometricBounds).toEqual(box);
    // Scaled up so each quadrant is two pixels wide or more.
    const big = { x: 10, y: 10, width: size.width * 4, height: size.height * 4 };
    ok(
      await call("kalamo_node_transform", {
        docId,
        nodeIds: [byDefault.id],
        scale: 4,
        pivot: { x: 10, y: 10 },
      }),
    );
    expect(await quadrants(docId, big)).toBe(UPRIGHT_QUADRANTS[o]);
    expect(await quadrants(docId, box)).toBe(UPRIGHT_QUADRANTS[o]);
    expect(await served(docId, byDefault.src)).toEqual(upright(bytesOf(src)));
    expect(boxed.src).toBe(byDefault.src);
  });

  it("turns an Image inside inline children, and after a refused item with partial", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const image = { type: "image", src: orientedJpeg(6), x: 0, y: 0 };
    const group = {
      type: "group",
      parentId: defaultLayerId,
      children: [{ type: "group", children: [image] }],
    };
    const refused = { type: "image", parentId: defaultLayerId, src: WEBP_ANIMATED, x: 0, y: 0 };
    const created = ok(
      await call("kalamo_node_create", { docId, partial: true, nodes: [refused, group] }),
    );
    expect(created.structuredContent.failed).toMatchObject([{ index: 0, code: "INVALID_IMAGE" }]);
    const nodes = await full(docId, created.structuredContent.createdIds);
    const node = nodes.find((n: { type: string }) => n.type === "image");
    expect(node.geometricBounds).toEqual({ x: 0, y: 0, width: 4, height: 8 });
  });

  it("stores one file for the same photo in any orientation, and an id keeps the stored pixels", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const image = (src: string) => ({ type: "image", parentId: defaultLayerId, src, x: 0, y: 0 });
    const created = ok(
      await call("kalamo_node_create", {
        docId,
        nodes: [image(orientedJpeg(6)), image(orientedJpeg(6)), image(orientedJpeg(8))],
      }),
    );
    const nodes = await full(docId, created.structuredContent.createdIds);
    const [src = ""] = new Set<string>(nodes.map((n: { src: string }) => n.src));
    expect(nodes.map((n: { src: string }) => n.src)).toEqual([src, src, src]);
    expect(nodes.map((n: { transform: number[] }) => n.transform.slice(0, 4))).toEqual([
      [0, 1, -1, 0],
      [0, 1, -1, 0],
      [0, -1, 1, 0],
    ]);
    const objects = await env.IMAGES.list({ prefix: imageKey(docId, "") });
    expect(objects.objects).toHaveLength(1);
    const again = ok(await call("kalamo_node_create", { docId, nodes: [image(src)] }));
    const [byId] = await full(docId, again.structuredContent.createdIds);
    expect(byId).toMatchObject({ width: 8, height: 4, transform: [1, 0, 0, 1, 0, 0] });
  });

  it("keeps the orientation out of node_get, the image rows and .kalamo.json", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const created = ok(
      await call("kalamo_node_create", {
        docId,
        nodes: [{ type: "image", parentId: defaultLayerId, src: orientedJpeg(6), x: 0, y: 0 }],
      }),
    );
    const got = await call("kalamo_node_get", {
      docId,
      nodeIds: created.structuredContent.createdIds,
      detail: "full",
    });
    const text = await kalamoJson(docId);
    for (const s of [JSON.stringify(got), text])
      expect(s.toLowerCase()).not.toContain("orientation");
    const file = JSON.parse(text);
    const src = got.structuredContent.nodes[0].src;
    expect(Object.keys(file.images)).toEqual([src]);
    expect(await imageId(bytesOf(file.images[src]))).toBe(src);
  });
});

describe("Relink to an oriented JPEG (ADR-0042, ADR-0101)", () => {
  const withUpright = async () => {
    const { docId, defaultLayerId } = await newDoc();
    const created = ok(
      await call("kalamo_node_create", {
        docId,
        nodes: [
          {
            type: "image",
            parentId: defaultLayerId,
            src: QUADRANTS_8x4_JPEG,
            x: 10,
            y: 10,
            width: 32,
            height: 16,
          },
        ],
      }),
    );
    const [nodeId = ""] = created.structuredContent.createdIds as string[];
    return { docId, nodeId };
  };
  const box = { x: 10, y: 10, width: 32, height: 16 };

  it("kalamo_node_update keeps the box and swaps the frame; an id keeps today's behaviour", async () => {
    const { docId, nodeId } = await withUpright();
    ok(
      await call("kalamo_node_update", {
        docId,
        updates: [{ nodeId, patch: { src: orientedJpeg(6) } }],
      }),
    );
    const [node] = await full(docId, [nodeId]);
    expect(node).toMatchObject({
      x: 18,
      y: 2,
      width: 16,
      height: 32,
      transform: [0, 1, -1, 0, 44, -8],
    });
    expect(node.geometricBounds).toEqual(box);
    expect(await quadrants(docId, box)).toBe(UPRIGHT_QUADRANTS[6]);
    // The id of the stored, upright file: nothing turns again.
    ok(
      await call("kalamo_node_update", { docId, updates: [{ nodeId, patch: { src: node.src } }] }),
    );
    expect((await full(docId, [nodeId]))[0]).toMatchObject({
      width: 16,
      height: 32,
      transform: node.transform,
    });
  });

  it("the relink-image route does the same", async () => {
    const { docId, nodeId } = await withUpright();
    const res = await exports.default.fetch(
      `http://kalamo/api/docs/${docId}/relink-image?nodeId=${nodeId}`,
      {
        method: "POST",
        body: bytesOf(orientedJpeg(6)),
      },
    );
    expect(res.status).toBe(200);
    const [node] = await full(docId, [nodeId]);
    expect(node).toMatchObject({ width: 16, height: 32 });
    expect(node.geometricBounds).toEqual(box);
    expect(await quadrants(docId, box)).toBe(UPRIGHT_QUADRANTS[6]);
  });
});

/** The upright pixel size of orientedJpeg(o). */
const uprightOf = (o: number) => (o >= 5 ? { width: 4, height: 8 } : { width: 8, height: 4 });

describe("Place", () => {
  it.each(ORIENTATIONS)(
    "kalamo_image_place sizes and centres orientation %i upright, and takes a frame as the upright box",
    async (o) => {
      const { docId, defaultLayerId } = await newDoc();
      const size = uprightOf(o);
      const place = async (extra: object = {}) => {
        const placed = ok(
          await call("kalamo_image_place", {
            docId,
            src: orientedJpeg(o),
            parentId: defaultLayerId,
            ...extra,
          }),
        );
        return (await full(docId, placed.structuredContent.createdIds))[0].geometricBounds;
      };
      expect(await place()).toEqual({ x: 100 - size.width / 2, y: 50 - size.height / 2, ...size });
      expect(await place({ frame: { x: 10, y: 10 } })).toEqual({ x: 10, y: 10, ...size });
      const box = { x: 20, y: 10, width: size.width * 4, height: size.height * 4 };
      expect(await place({ frame: box })).toEqual(box);
      expect(await quadrants(docId, box)).toBe(UPRIGHT_QUADRANTS[o]);
    },
  );

  it.each(ORIENTATIONS)(
    "the place-image route centres orientation %i upright on the point",
    async (o) => {
      const { docId, defaultLayerId } = await newDoc();
      const res = await exports.default.fetch(
        `http://kalamo/api/docs/${docId}/place-image?parentId=${defaultLayerId}&x=50&y=40`,
        { method: "POST", body: bytesOf(orientedJpeg(o)) },
      );
      const size = uprightOf(o);
      const box = { x: 50 - size.width / 2, y: 40 - size.height / 2, ...size };
      expect(await res.json()).toMatchObject({ bounds: box });
      expect(await quadrants(docId, box)).toBe(UPRIGHT_QUADRANTS[o]);
    },
  );
});

describe("Open", () => {
  const opened = async (docId: string, o: number) => {
    const size = uprightOf(o);
    const file = JSON.parse(await kalamoJson(docId));
    expect(file.artboards[0].frame).toEqual({ x: 0, y: 0, ...size });
    const image = file.nodes.find((n: { type: string }) => n.type === "image");
    expect(await served(docId, image.src)).toEqual(upright(bytesOf(orientedJpeg(o))));
    const [node] = await full(docId, [image.id]);
    expect(node.geometricBounds).toEqual({ x: 0, y: 0, ...size });
    // 4 pt per pixel, so each quadrant is several pixels wide.
    ok(
      await call("kalamo_node_transform", {
        docId,
        nodeIds: [image.id],
        scale: 4,
        pivot: { x: 0, y: 0 },
      }),
    );
    const box = { x: 0, y: 0, width: size.width * 4, height: size.height * 4 };
    expect(await quadrants(docId, box)).toBe(UPRIGHT_QUADRANTS[o]);
  };

  it.each(ORIENTATIONS)(
    "kalamo_doc_open makes the Artboard orientation %i's upright size",
    async (o) => {
      const result = ok(
        await call("kalamo_doc_open", { content: orientedJpeg(o), name: "photo.jpg" }),
      );
      await opened(result.structuredContent.docId, o);
    },
  );

  it.each(ORIENTATIONS)("POST /api/docs does the same for orientation %i", async (o) => {
    const res = await exports.default.fetch("http://kalamo/api/docs", {
      method: "POST",
      body: bytesOf(orientedJpeg(o)),
    });
    expect(res.status).toBe(200);
    await opened(((await res.json()) as { docId: string }).docId, o);
  });

  it("loads a .kalamo.json image untouched, orientation and all", async () => {
    const { docId, defaultLayerId } = await newDoc();
    ok(
      await call("kalamo_node_create", {
        docId,
        nodes: [{ type: "image", parentId: defaultLayerId, src: QUADRANTS_8x4_JPEG, x: 0, y: 0 }],
      }),
    );
    const file = JSON.parse(await kalamoJson(docId));
    const raw = bytesOf(orientedJpeg(6));
    const id = await imageId(raw);
    const [old = ""] = Object.keys(file.images);
    const text = JSON.stringify(file)
      .replaceAll(old, id)
      .replace(QUADRANTS_8x4_JPEG, orientedJpeg(6));
    const reopened = ok(await call("kalamo_doc_open", { content: text })).structuredContent.docId;
    const image = JSON.parse(await kalamoJson(reopened)).nodes.find(
      (n: { type: string }) => n.type === "image",
    );
    expect(image).toMatchObject({ src: id, width: 8, height: 4, transform: [1, 0, 0, 1, 0, 0] });
    expect(await served(reopened, id)).toEqual(raw);
  });
});

describe("an SVG <image> of an oriented JPEG", () => {
  const svg = (attrs: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="60" height="40" viewBox="0 0 60 40"><image x="10" y="10" width="40" height="20" ${attrs} xlink:href="${orientedJpeg(6)}"/></svg>`;
  // What Inkscape 1.2.2 draws at these points of the same SVG (--export-dpi=384): the cell centres
  // of a 4 × 2 grid over the box, then the meet region's quadrant centres.
  const GRID: [number, number][] = [15, 25].flatMap((y) =>
    [15, 25, 35, 45].map((x): [number, number] => [x, y]),
  );
  it.each([
    ['preserveAspectRatio="none"', GRID, "BBRRYYGG"],
    [
      'preserveAspectRatio="xMinYMid meet"',
      [
        [12.5, 15],
        [17.5, 15],
        [12.5, 25],
        [17.5, 25],
      ],
      "BRYG",
    ],
    ['preserveAspectRatio="xMidYMax slice"', GRID, "YYGGYYGG"],
    [
      'preserveAspectRatio="xMinYMid meet" transform="matrix(-1 0 0 1 60 0)"',
      [
        [42.5, 15],
        [47.5, 15],
        [42.5, 25],
        [47.5, 25],
      ],
      "RBGY",
    ],
  ] as [string, [number, number][], string][])(
    "renders %s as Inkscape does, and comes back from export",
    async (attrs, points, want) => {
      const result = ok(await call("kalamo_doc_open", { content: svg(attrs) }));
      const { docId } = result.structuredContent;
      expect(await colours(docId, points, { x: 0, y: 0, width: 60, height: 40 })).toBe(want);
      const [image] = JSON.parse(await kalamoJson(docId)).nodes.filter(
        (n: { type: string }) => n.type === "image",
      );
      expect(await served(docId, image.src)).toEqual(upright(bytesOf(orientedJpeg(6))));
      const exported = (await call("kalamo_export", { docId, format: "svg" })).content[0]
        .text as string;
      const again = ok(await call("kalamo_doc_open", { content: exported })).structuredContent
        .docId;
      const [back] = JSON.parse(await kalamoJson(again)).nodes.filter(
        (n: { type: string }) => n.type === "image",
      );
      for (const key of ["src", "x", "y", "width", "height", "transform", "preserveAspectRatio"]) {
        expect(back[key], key).toEqual(image[key]);
      }
    },
  );

  it("kalamo_svg_import sizes an unsized <image> upright", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const placed = ok(
      await call("kalamo_svg_import", {
        docId,
        parentId: defaultLayerId,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="60" height="40"><image x="10" y="10" xlink:href="${orientedJpeg(6)}"/></svg>`,
      }),
    );
    const nodes = await full(docId, placed.structuredContent.createdIds);
    const image = nodes.find((n: { type: string }) => n.type === "image");
    expect(image.geometricBounds).toMatchObject({ width: 4, height: 8 });
  });
});

describe("a linked Image of an oriented JPEG (ADR-0102)", () => {
  const box = { x: 10, y: 10, width: 32, height: 16 };
  const linked = async (src: string, extra: object = {}) => {
    const { docId, defaultLayerId } = await newDoc();
    const created = ok(
      await call("kalamo_node_create", {
        docId,
        nodes: [
          { type: "image", parentId: defaultLayerId, file: "photo.jpg", src, ...box, ...extra },
        ],
      }),
    );
    const [nodeId = ""] = created.structuredContent.createdIds as string[];
    return { docId, defaultLayerId, nodeId };
  };
  const node = async (docId: string, nodeId: string) => (await full(docId, [nodeId]))[0];
  const update = async (docId: string, nodeId: string, patch: object) =>
    ok(await call("kalamo_node_update", { docId, updates: [{ nodeId, patch }] }));
  const svgOf = async (docId: string) =>
    (await call("kalamo_export", { docId, format: "svg" })).content[0].text as string;

  it.each(ORIENTATIONS)("node_create with file records orientation %i", async (o) => {
    const { docId, nodeId } = await linked(orientedJpeg(o));
    const got = await node(docId, nodeId);
    if (o === 1) expect(got).not.toHaveProperty("fileOrientation");
    else expect(got.fileOrientation).toBe(o);
    expect(got.geometricBounds).toEqual(box);
    expect(await quadrants(docId, box)).toBe(UPRIGHT_QUADRANTS[o]);
  });

  it("records it inside inline children, and never on an embedded Image", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const image = { type: "image", src: orientedJpeg(6), x: 0, y: 0 };
    const created = ok(
      await call("kalamo_node_create", {
        docId,
        nodes: [
          { type: "group", parentId: defaultLayerId, children: [{ ...image, file: "a.jpg" }] },
          { ...image, parentId: defaultLayerId },
        ],
      }),
    );
    const images = (await full(docId, created.structuredContent.createdIds)).filter(
      (n: { type: string }) => n.type === "image",
    );
    expect(images.map((n: { fileOrientation?: number }) => n.fileOrientation)).toEqual([
      6,
      undefined,
    ]);
  });

  it("Relink by node_update src sets it, an upright file or an image id clears it, file alone keeps it", async () => {
    const { docId, nodeId } = await linked(QUADRANTS_8x4_JPEG);
    expect(await node(docId, nodeId)).not.toHaveProperty("fileOrientation");
    await update(docId, nodeId, { src: orientedJpeg(6) });
    const turned = await node(docId, nodeId);
    expect(turned).toMatchObject({ fileOrientation: 6, width: 16, height: 32 });
    expect(turned.geometricBounds).toEqual(box);
    await update(docId, nodeId, { file: "renamed.jpg" });
    expect(await node(docId, nodeId)).toMatchObject({ file: "renamed.jpg", fileOrientation: 6 });
    await update(docId, nodeId, { src: turned.src });
    const byId = await node(docId, nodeId);
    expect(byId).not.toHaveProperty("fileOrientation");
    expect(byId.transform).toEqual(turned.transform);
    await update(docId, nodeId, { src: orientedJpeg(5) });
    expect((await node(docId, nodeId)).fileOrientation).toBe(5);
    await update(docId, nodeId, { src: QUADRANTS_8x4_JPEG });
    expect(await node(docId, nodeId)).not.toHaveProperty("fileOrientation");
    // src and file in one patch link an embedded Image and record it.
    const embedded = await linked(QUADRANTS_8x4_JPEG, { file: undefined });
    await update(embedded.docId, embedded.nodeId, { src: orientedJpeg(8), file: "b.jpg" });
    expect((await node(embedded.docId, embedded.nodeId)).fileOrientation).toBe(8);
  });

  it("the relink-image route sets it on a linked Image only", async () => {
    const relink = async (docId: string, nodeId: string, o: number) => {
      const res = await exports.default.fetch(
        `http://kalamo/api/docs/${docId}/relink-image?nodeId=${nodeId}`,
        { method: "POST", body: bytesOf(orientedJpeg(o)) },
      );
      expect(res.status).toBe(200);
      return node(docId, nodeId);
    };
    const a = await linked(QUADRANTS_8x4_JPEG);
    expect((await relink(a.docId, a.nodeId, 7)).fileOrientation).toBe(7);
    expect(await relink(a.docId, a.nodeId, 1)).not.toHaveProperty("fileOrientation");
    const b = await linked(QUADRANTS_8x4_JPEG, { file: undefined });
    expect(await relink(b.docId, b.nodeId, 6)).not.toHaveProperty("fileOrientation");
  });

  it("Embed by file: null clears it and keeps what render draws", async () => {
    const { docId, nodeId } = await linked(orientedJpeg(6));
    const before = await node(docId, nodeId);
    await update(docId, nodeId, { file: null });
    const after = await node(docId, nodeId);
    expect(after).not.toHaveProperty("fileOrientation");
    const { file: _, fileOrientation: __, ...kept } = before;
    expect(after).toMatchObject(kept);
    expect(await quadrants(docId, box)).toBe(UPRIGHT_QUADRANTS[6]);
  });

  it("Duplicate keeps it; node_create and node_update refuse it", async () => {
    const { docId, defaultLayerId, nodeId } = await linked(orientedJpeg(6));
    const dup = ok(await call("kalamo_node_duplicate", { docId, nodeIds: [nodeId] }));
    expect((await node(docId, dup.structuredContent.createdIds[0])).fileOrientation).toBe(6);
    const patch = await call("kalamo_node_update", {
      docId,
      updates: [{ nodeId, patch: { fileOrientation: 3 } }],
    });
    expect(errorOf(patch)).toMatchObject({
      code: "INVALID_PATCH",
      path: "updates[0].patch.fileOrientation",
    });
    const created = await call("kalamo_node_create", {
      docId,
      nodes: [
        {
          type: "image",
          parentId: defaultLayerId,
          file: "a.jpg",
          src: QUADRANTS_8x4_JPEG,
          x: 0,
          y: 0,
          fileOrientation: 6,
        },
      ],
    });
    expect(errorOf(created)).toMatchObject({
      code: "INVALID_INPUT",
      path: "nodes[0].fileOrientation",
    });
  });

  it.each([6, 7])(
    "export SVG writes orientation %i's upright box; import into the same Document gives the Node back, into a new one a missing link",
    async (o) => {
      const { docId, defaultLayerId, nodeId } = await linked(orientedJpeg(o));
      const image = await node(docId, nodeId);
      const svg = await svgOf(docId);
      const tag = /<image [^>]*\/>/.exec(svg)?.[0] ?? "";
      expect(tag).toContain(`kalamo:fileOrientation="${o}"`);
      expect(tag).toContain('x="10" y="10" width="32" height="16"');
      expect(tag).toContain('xlink:href="photo.jpg"');
      expect(tag).not.toContain("transform=");
      // render is untouched by the export mode.
      expect(await quadrants(docId, box)).toBe(UPRIGHT_QUADRANTS[o]);

      const placed = ok(
        await call("kalamo_svg_import", {
          docId,
          parentId: defaultLayerId,
          svg,
          position: { x: 26, y: 18 },
        }),
      );
      const back = (await full(docId, placed.structuredContent.createdIds)).find(
        (n: { type: string }) => n.type === "image",
      );
      for (const key of [
        "src",
        "file",
        "fileOrientation",
        "x",
        "y",
        "width",
        "height",
        "preserveAspectRatio",
      ]) {
        expect(back[key], key).toEqual(image[key]);
      }
      expect(back.geometricBounds).toEqual(box);

      const other = ok(await call("kalamo_doc_open", { content: svg })).structuredContent.docId;
      const missing = JSON.parse(await kalamoJson(other)).nodes.find(
        (n: { type: string }) => n.type === "image",
      );
      expect(missing).toMatchObject({ file: "photo.jpg", ...box, transform: [1, 0, 0, 1, 0, 0] });
      expect(missing).not.toHaveProperty("src");
      expect(missing).not.toHaveProperty("fileOrientation");
      // Relinked to the oriented file, it shows the same box and records the file again.
      await update(other, missing.id, { src: orientedJpeg(o) });
      const relinked = await node(other, missing.id);
      expect(relinked.fileOrientation).toBe(o);
      expect(relinked.geometricBounds).toEqual(box);
      expect(await quadrants(other, box)).toBe(UPRIGHT_QUADRANTS[o]);
    },
  );

  it("saves it in .kalamo.json and loads it back", async () => {
    const { docId, nodeId } = await linked(orientedJpeg(6));
    const text = await kalamoJson(docId);
    expect(JSON.parse(text).nodes.find((n: { id: string }) => n.id === nodeId)).toMatchObject({
      fileOrientation: 6,
    });
    const reopened = ok(await call("kalamo_doc_open", { content: text })).structuredContent.docId;
    const image = JSON.parse(await kalamoJson(reopened)).nodes.find(
      (n: { type: string }) => n.type === "image",
    );
    expect(image.fileOrientation).toBe(6);
  });
});

it("the embed command clears it, and undo and redo bring it back and take it away", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [nodeId = ""] = ok(
    await call("kalamo_node_create", {
      docId,
      nodes: [
        {
          type: "image",
          parentId: defaultLayerId,
          file: "a.jpg",
          src: orientedJpeg(6),
          x: 0,
          y: 0,
        },
      ],
    }),
  ).structuredContent.createdIds;
  const res = await exports.default.fetch(`http://kalamo/api/docs/${docId}/ws`, {
    headers: { upgrade: "websocket" },
  });
  const ws = res.webSocket as WebSocket;
  const messages: { type: string; commandId?: string }[] = [];
  ws.addEventListener("message", (e) => {
    messages.push(JSON.parse(e.data as string));
  });
  ws.accept();
  const send = async (id: string, command: object) => {
    ws.send(JSON.stringify({ type: "command", id, command }));
    while (!messages.some((m) => m.commandId === id)) await new Promise((r) => setTimeout(r, 5));
    return (await full(docId, [nodeId]))[0].fileOrientation;
  };
  expect(await send("e1", { type: "embed", nodeIds: [nodeId] })).toBeUndefined();
  expect(await send("u1", { type: "undo" })).toBe(6);
  expect(await send("r1", { type: "redo" })).toBeUndefined();
  ws.close();
});
