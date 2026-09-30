import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function create(request: APIRequestContext, name: string) {
  return (
    await call(request, "kalamo_doc_create", { name, artboards: [{ width: 200, height: 100 }] })
  ).structuredContent as { docId: string; defaultLayerId: string };
}

async function show(page: Page, docId: string) {
  await page.goto(`/docs/${docId}`);
  await expect(page.locator("body")).toContainText(/\d+%/);
}

/** The Layer's children in full, without what a paste changes: id, index and parent. */
async function children(
  request: APIRequestContext,
  docId: string,
  layerId: string,
): Promise<Record<string, unknown>[]> {
  // A write landing between the two reads, such as a cut's delete, makes node_get refuse ids the
  // outline just listed. The reads start over, since expect.poll fails at once on a throw.
  for (let attempt = 0; ; attempt++) {
    const { nodes } = (
      await call(request, "kalamo_doc_outline", { docId, rootId: layerId, depth: 1 })
    ).structuredContent as { nodes: { id: string }[] };
    if (nodes.length === 0) return [];
    const got = await call(request, "kalamo_node_get", {
      docId,
      nodeIds: nodes.map((n) => n.id),
      detail: "full",
    });
    if (got.structuredContent) {
      const full = got.structuredContent.nodes as Record<string, unknown>[];
      return full.map(({ id, index, parentId, ...n }) => n);
    }
    if (attempt === 2) throw new Error(`node_get failed: ${got.content?.[0]?.text}`);
  }
}

test("cut, copy and paste move Nodes between Document tabs, ungrouped, as one Transaction each", async ({
  page,
  request,
}) => {
  const a = await create(request, "Copy from");
  const b = await create(request, "Paste into");
  await call(request, "kalamo_node_create", {
    docId: a.docId,
    nodes: [
      {
        type: "rect",
        parentId: a.defaultLayerId,
        name: "Box",
        x: 10,
        y: 10,
        width: 30,
        height: 20,
        appearance: { fills: [{ color: "#FF0000" }], strokes: [{ color: "#0000FF", width: 2 }] },
      },
      { type: "text", parentId: a.defaultLayerId, name: "Hi", x: 60, y: 50, content: "Hi" },
    ],
  });
  const source = await children(request, a.docId, a.defaultLayerId);

  await show(page, a.docId);
  await page.keyboard.press("Control+A");
  await expect(page.getByRole("button", { name: "Box", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Control+C");

  // Paste centres the pair in the view; the Artboard is fitted, so on its centre.
  await show(page, b.docId);
  await page.keyboard.press("Control+V");
  await expect
    .poll(async () => (await children(request, b.docId, b.defaultLayerId)).length)
    .toBe(2);
  const pasted = await children(request, b.docId, b.defaultLayerId);
  expect(pasted.map((n) => [n.type, n.name])).toEqual([
    ["rect", "Box"],
    ["text", "Hi"],
  ]);
  for (const [i, n] of pasted.entries()) {
    const { transform, worldTransform, geometricBounds, visibleBounds, ...rest } = source[
      i
    ] as Record<string, unknown>;
    expect(n).toMatchObject(rest);
  }
  const { x, width } = (pasted[0] as { geometricBounds: { x: number; width: number } })
    .geometricBounds;
  // The pair spans x 10 .. about 70 in the source; centred, it is moved, not where it was.
  expect(x).not.toBeCloseTo(10, 0);
  expect(width).toBeCloseTo(30);
  // What was pasted is the Selection.
  await expect(page.getByRole("button", { name: "Hi", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Paste in Place keeps the file's coordinates.
  await page.keyboard.press("Control+Shift+V");
  await expect
    .poll(async () => (await children(request, b.docId, b.defaultLayerId)).length)
    .toBe(4);
  const inPlace = (await children(request, b.docId, b.defaultLayerId)).slice(2);
  expect(inPlace).toEqual(source);

  // Cut deletes the Selection as one Transaction, and undo brings it back.
  await show(page, a.docId);
  await page.keyboard.press("Control+A");
  await expect(page.getByRole("button", { name: "Box", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Control+X");
  await expect
    .poll(async () => (await children(request, a.docId, a.defaultLayerId)).length)
    .toBe(0);
  await page.keyboard.press("Control+Z");
  await expect.poll(async () => children(request, a.docId, a.defaultLayerId)).toEqual(source);
  // What was cut pastes back.
  await page.keyboard.press("Control+Shift+V");
  await expect
    .poll(async () => (await children(request, a.docId, a.defaultLayerId)).length)
    .toBe(4);
});
