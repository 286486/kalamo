import { env } from "cloudflare:workers";
import { newId, readImage } from "@kalamo/core";
import { describe, expect, it } from "vitest";
import { BLUE_1x1_PNG, RED_2x2_PNG } from "../../../fixtures/images.ts";
import { imageKey } from "../src/document-object.ts";
import { browser, bytes, type Person, person, shareWith, socket, tool } from "./people.ts";
import { call, errorOf } from "./rpc.ts";

const MB = 1024 * 1024;

const userId = async (who: Person) =>
  (await env.DB.prepare("SELECT id FROM users WHERE login = ?")
    .bind(who.login)
    .first<string>("id")) as string;

/** `n` Document rows owned by `who`, as if created earlier. */
async function seedDocuments(who: Person, n: number, storedBytes = 0) {
  const owner = await userId(who);
  const ids = Array.from({ length: n }, () => newId());
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare(
        "INSERT INTO documents (id, name, created_at, owner_id, stored_bytes) VALUES (?, 'Seeded', '', ?, ?)",
      ).bind(id, owner, storedBytes),
    ),
  );
  return ids;
}

const today = () => new Date().toISOString().slice(0, 10);

async function seedUsage(who: Person, kind: string, n: number, day = today()) {
  await env.DB.prepare("INSERT INTO usage (user_id, day, kind, n) VALUES (?, ?, ?, ?)")
    .bind(await userId(who), day, kind, n)
    .run();
}

const usage = async (who: Person, kind: string, day = today()) =>
  env.DB.prepare("SELECT n FROM usage WHERE user_id = ? AND day = ? AND kind = ?")
    .bind(await userId(who), day, kind)
    .first<number>("n");

async function newDoc(who: Person) {
  const { ok } = await tool(who, "kalamo_doc_create", {
    name: "Mine",
    artboards: [{ width: 10, height: 10 }],
  });
  return ok as { docId: string; defaultLayerId: string };
}

const nextMidnight = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
};

describe("50 owned Documents", () => {
  it("refuses the 51st through doc_create, doc_open and the browser's Open; shared ones do not count", async () => {
    const [ann, other] = [await person("ann"), await person("other")];
    const shared = await newDoc(other);
    expect((await shareWith(other, shared.docId, "ann", "editor")).status).toBe(200);
    await seedDocuments(ann, 49);
    expect(
      (await tool(ann, "kalamo_doc_create", { name: "50th", artboards: [{ width: 1, height: 1 }] }))
        .error,
    ).toBeNull();

    const limit = { name: "documents", limit: 50, used: 50 };
    const refused = {
      code: "LIMIT_EXCEEDED",
      message: expect.stringContaining("50 of 50 Documents"),
      hint: expect.stringContaining("Delete a Document"),
      limit,
    };
    const created = await tool(ann, "kalamo_doc_create", {
      name: "51st",
      artboards: [{ width: 1, height: 1 }],
    });
    expect(created.error).toEqual(refused);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
    expect((await tool(ann, "kalamo_doc_open", { content: svg })).error).toEqual(refused);
    const open = await browser(ann, "/api/docs?name=a.svg", { method: "POST", body: svg });
    expect(await open.json()).toEqual(refused);
    const owned = await env.DB.prepare("SELECT COUNT(*) AS n FROM documents WHERE owner_id = ?")
      .bind(await userId(ann))
      .first<number>("n");
    expect(owned).toBe(50);
  });
});

describe("daily render and export calls", () => {
  it("refuses the 501st render of the UTC day with the reset time; a new day starts over", async () => {
    const bea = await person("bea");
    const { docId } = await newDoc(bea);
    await seedUsage(bea, "render", 500, "2020-01-01");
    await seedUsage(bea, "render", 499);
    expect((await tool(bea, "kalamo_render", { docId })).error).toBeNull();
    const { error } = await tool(bea, "kalamo_render", { docId });
    expect(error).toEqual({
      code: "LIMIT_EXCEEDED",
      message: expect.stringContaining("500 kalamo_render calls"),
      hint: expect.stringContaining(nextMidnight()),
      limit: { name: "render", limit: 500, used: 500, resetsAt: nextMidnight() },
    });
    expect(await usage(bea, "render")).toBe(501);
    expect(await usage(bea, "render", "2020-01-01")).toBe(500);
  });

  it("counts every export format, a png too, as an export, and refuses the 201st", async () => {
    const cy = await person("cy");
    const { docId } = await newDoc(cy);
    await seedUsage(cy, "export", 197);
    for (const format of ["png", "svg", "kalamo_json"]) {
      expect((await tool(cy, "kalamo_export", { docId, format })).error).toBeNull();
    }
    expect(await usage(cy, "render")).toBeNull();
    const { error } = await tool(cy, "kalamo_export", { docId, format: "kalamo_json" });
    expect(error).toMatchObject({
      code: "LIMIT_EXCEEDED",
      limit: { name: "export", limit: 200, used: 200, resetsAt: nextMidnight() },
    });
  });

  it("counts a viewer's render against the viewer, not the owner", async () => {
    const [owner, viewer] = [await person("dee"), await person("vee")];
    const { docId } = await newDoc(owner);
    expect((await shareWith(owner, docId, "vee", "viewer")).status).toBe(200);
    expect((await tool(viewer, "kalamo_render", { docId })).error).toBeNull();
    expect(await usage(viewer, "render")).toBe(1);
    expect(await usage(owner, "render")).toBeNull();
  });
});

describe("20 browser connections per Document", () => {
  it("sends the 21st socket rejected and closes it with 4029; a freed slot connects", async () => {
    const eve = await person("eve");
    const { docId } = await newDoc(eve);
    const open = [];
    for (let i = 0; i < 20; i++) {
      const s = await socket(eve, docId);
      expect(await s.next?.()).toMatchObject({ type: "document" });
      open.push(s);
    }
    const refused = await socket(eve, docId);
    expect(await refused.next?.()).toEqual({
      type: "rejected",
      id: "",
      error: {
        code: "LIMIT_EXCEEDED",
        message: expect.stringContaining("Too many open tabs on this Document"),
        hint: expect.any(String),
        limit: { name: "connections", limit: 20, used: 20 },
      },
    });
    expect((await refused.closed)?.code).toBe(4029);

    open[0]?.ws?.close();
    await open[0]?.closed;
    const again = await socket(eve, docId);
    expect(await again.next?.()).toMatchObject({ type: "document" });
    for (const s of [...open, again]) s.ws?.close();
  });
});

describe("200 MB stored per owner", () => {
  const blue = readImage(BLUE_1x1_PNG, "src").bytes.length;

  it("refuses an editor's upload past the owner's storage, with nothing stored", async () => {
    const [owner, editor] = [await person("fay"), await person("gus")];
    const { docId, defaultLayerId } = await newDoc(owner);
    expect((await shareWith(owner, docId, "gus", "editor")).status).toBe(200);
    // The owner's other Documents hold all but a byte less than the file.
    await seedDocuments(owner, 1, 200 * MB - blue + 1);
    const refused = {
      code: "LIMIT_EXCEEDED",
      message: `Your Documents store ${200 * MB - blue + 1} bytes of image files; ${blue} more would pass your storage limit of ${200 * MB} (200 MB) across the Documents you own.`,
      hint: expect.stringContaining("Delete Images"),
      limit: { name: "storage", limit: 200 * MB, used: 200 * MB - blue + 1 },
    };
    const placed = await browser(
      editor,
      `/api/docs/${docId}/place-image?parentId=${defaultLayerId}`,
      { method: "POST", body: bytes(BLUE_1x1_PNG) },
    );
    expect(await placed.json()).toEqual(refused);
    const image = { type: "image", parentId: defaultLayerId, src: BLUE_1x1_PNG, x: 0, y: 0 };
    const created = await tool(editor, "kalamo_node_create", { docId, nodes: [image] });
    expect(created.error).toEqual(refused);
    expect((await env.IMAGES.list({ prefix: imageKey(docId, "") })).objects).toEqual([]);
    const stub = env.DOCUMENT.get(env.DOCUMENT.idFromName(docId));
    expect(await stub.storedImageBytes()).toBe(0);

    // A file under what is left still fits, and its bytes land in the Document's row.
    const red = readImage(RED_2x2_PNG, "src").bytes.length;
    await env.DB.prepare("UPDATE documents SET stored_bytes = ? WHERE owner_id = ? AND id != ?")
      .bind(200 * MB - red, await userId(owner), docId)
      .run();
    const fits = { ...image, src: RED_2x2_PNG };
    expect((await tool(editor, "kalamo_node_create", { docId, nodes: [fits] })).error).toBeNull();
    const row = await env.DB.prepare("SELECT stored_bytes FROM documents WHERE id = ?")
      .bind(docId)
      .first<number>("stored_bytes");
    expect(row).toBe(red);
  });

  it("gives an opened Document's row its images' bytes", async () => {
    const hal = await person("hal");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1" height="1"><image width="1" height="1" xlink:href="${BLUE_1x1_PNG}"/></svg>`;
    const { ok } = await tool(hal, "kalamo_doc_open", { content: svg });
    const row = await env.DB.prepare("SELECT stored_bytes FROM documents WHERE id = ?")
      .bind(ok.docId)
      .first<number>("stored_bytes");
    expect(row).toBe(blue);
  });
});

describe("dev mode", () => {
  it("enforces no Quota", async () => {
    await env.DB.prepare(
      "INSERT INTO usage (user_id, day, kind, n) VALUES ('local', ?, 'render', 9999)",
    )
      .bind(today())
      .run();
    const { docId } = (
      await call("kalamo_doc_create", { name: "D", artboards: [{ width: 1, height: 1 }] })
    ).structuredContent;
    expect(errorOf(await call("kalamo_render", { docId }))).toBeNull();
    const n = await env.DB.prepare("SELECT n FROM usage WHERE user_id = 'local' AND day = ?")
      .bind(today())
      .first<number>("n");
    expect(n).toBe(9999);
  });
});
