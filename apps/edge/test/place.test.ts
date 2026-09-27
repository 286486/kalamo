import { env } from "cloudflare:workers";
import { parseFile } from "@zibel/io";
import { expect, it } from "vitest";

const stub = (docId: string) => env.DOCUMENT.get(env.DOCUMENT.idFromName(docId));

const ok = <T extends object>(result: T): Exclude<T, { error: unknown }> => {
  if ("error" in result) throw new Error(JSON.stringify(result.error));
  return result as Exclude<T, { error: unknown }>;
};

/** An Inkscape file with two layers, a rect in each, on a 100 × 100 mm page. */
const TWO_LAYERS = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="100mm" height="100mm" viewBox="0 0 100 100" sodipodi:docname="logo.svg">
  <g inkscape:groupmode="layer" id="layer1" inkscape:label="Back"><rect id="rect1" x="0" y="0" width="10" height="5"/></g>
  <g inkscape:groupmode="layer" id="layer2" inkscape:label="Front"><rect id="rect2" x="10" y="0" width="10" height="5"/></g>
</svg>`;

/** A Document with one blue square on a 200 × 100 Artboard. */
async function setup(docId: string) {
  const s = stub(docId);
  const { defaultLayerId: layer } = ok(
    await s.create({ docId, name: "Doc", artboards: [{ width: 200, height: 100 }], actor: "a" }),
  );
  const square = { type: "rect" as const, parentId: layer, x: 0, y: 0, width: 10, height: 10 };
  ok(await s.createNodes([square], "agent-a"));
  return { s, layer };
}

const place = (s: ReturnType<typeof stub>, svg: string, opts: object) =>
  s.place(parseFile(svg), "user", opts as never);

it("places a two-layer Inkscape file as one Group of two Groups, all new ids, in one Transaction", async () => {
  const { s, layer } = await setup("place-two-layers");
  const { rev, nodeCount } = ok(await s.info());
  const receipt = ok(await place(s, TWO_LAYERS, { parentId: layer }));

  expect(receipt.rev).toBe(rev + 1);
  expect(receipt.createdIds).toHaveLength(5);
  expect(receipt.createdIds.some((id) => /^(layer|rect)\d$/.test(id))).toBe(false);
  expect(receipt.nodes).toMatchObject([
    {
      type: "group",
      name: "logo",
      children: [
        { type: "group", name: "Back", childCount: 1 },
        { type: "group", name: "Front", childCount: 1 },
      ],
    },
  ]);
  const [groupId] = receipt.createdIds;
  const outline = ok(await s.outline({ rootId: layer, depth: 1 }, "user")).nodes;
  expect(outline.at(-1)).toMatchObject({ id: groupId, type: "group", name: "logo", childCount: 2 });
  // 20 × 5 mm, centred on the Artboard.
  const mm = 72 / 25.4;
  expect(receipt.bounds?.x).toBeCloseTo(100 - 10 * mm, 2);
  expect(receipt.bounds?.width).toBeCloseTo(20 * mm, 2);
  expect(ok(await s.info()).nodeCount).toBe(nodeCount + 5);

  expect(ok(await s.changes(rev)).changes).toMatchObject([
    { actor: "user", createdIds: receipt.createdIds, updatedIds: [], deletedIds: [] },
  ]);
  ok(await s.undo("user"));
  expect(ok(await s.info()).nodeCount).toBe(nodeCount);
});

it("places the same file twice, and a file exported from the same Document, without collisions", async () => {
  const { s, layer } = await setup("place-twice");
  const { nodeCount } = ok(await s.info());
  const a = ok(await place(s, TWO_LAYERS, { parentId: layer }));
  const b = ok(await place(s, TWO_LAYERS, { parentId: layer }));
  expect(a.createdIds.filter((id) => b.createdIds.includes(id))).toEqual([]);
  expect(ok(await s.info()).nodeCount).toBe(nodeCount + 10);

  // The export keeps z-<id> ids, which Place must not reuse.
  const before = ok(await s.info()).nodeCount;
  const { svg } = ok(await s.svg("user", {}));
  const again = ok(await place(s, svg, { parentId: layer }));
  expect(again.createdIds).toHaveLength(before + 1);
  expect(ok(await s.info()).nodeCount).toBe(before * 2 + 1);
  expect(ok(await s.get(a.createdIds, "concise", "user")).nodes).toHaveLength(5);
});

it("pastes a Zibel copy's Nodes ungrouped, in place or centred, and undoes it", async () => {
  const { s, layer } = await setup("place-copy");
  const [rect] = ok(await s.outline({ rootId: layer }, "user")).nodes;
  const text = {
    type: "text" as const,
    parentId: layer,
    x: 50,
    y: 60,
    content: "Hi",
    appearance: { fills: [{ color: "#FF0000" }], strokes: [] },
  };
  const [textId] = ok(await s.createNodes([text], "user")).createdIds;
  const ids = [rect?.id as string, textId as string];
  const { svg } = ok(await s.svg("user", { scope: { nodeIds: ids } }));
  const { rev, nodeCount } = ok(await s.info());

  const pasted = ok(await place(s, svg, { parentId: layer, inPlace: true }));
  expect(pasted.nodes.map((n) => n.type)).toEqual(["rect", "text"]);
  expect(pasted.createdIds).toEqual(pasted.nodes.map((n) => n.id));
  // The same geometry and Appearance, above the originals.
  const [before, after] = [ids, pasted.createdIds].map(async (list) =>
    ok(await s.get(list, "full", "user")).nodes.map(({ id, ...n }) => ({ ...n, index: "" })),
  );
  expect(await after).toEqual(await before);
  expect(ok(await s.info()).nodeCount).toBe(nodeCount + 2);

  const centred = ok(await place(s, svg, { parentId: layer, position: { x: 0, y: 0 } }));
  const b = centred.bounds as { x: number; y: number; width: number; height: number };
  expect(b.x + b.width / 2).toBeCloseTo(0, 3);
  ok(await s.undo("user"));
  ok(await s.undo("user"));
  expect(ok(await s.info())).toMatchObject({ rev: rev + 4, nodeCount });
});

it("centres on position, and fit scales to the parent's Artboard", async () => {
  const { s, layer } = await setup("place-position");
  const at = ok(await place(s, TWO_LAYERS, { parentId: layer, position: { x: 0, y: 0 } }));
  const b = at.bounds as { x: number; y: number; width: number; height: number };
  expect(b.x + b.width / 2).toBeCloseTo(0, 3);
  expect(b.y + b.height / 2).toBeCloseTo(0, 3);

  const fitted = ok(await place(s, TWO_LAYERS, { parentId: layer, fit: true }));
  expect(fitted.bounds?.width).toBeCloseTo(200, 3);
  expect(fitted.bounds?.x).toBeCloseTo(0, 3);
});

it("refuses a .zibel.json and a parent that is not a Layer or Group, changing nothing", async () => {
  const { s, layer } = await setup("place-refused");
  const { rev } = ok(await s.info());
  const { text } = ok(await s.file("user"));
  expect(await place(s, text, { parentId: layer })).toMatchObject({
    error: { code: "INVALID_DOCUMENT", path: "svg" },
  });
  const [rect] = ok(await s.outline({ rootId: layer }, "user")).nodes;
  expect(await place(s, TWO_LAYERS, { parentId: rect?.id })).toMatchObject({
    error: { code: "INVALID_PARENT" },
  });
  expect(ok(await s.info()).rev).toBe(rev);
});
