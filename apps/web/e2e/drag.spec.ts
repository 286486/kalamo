import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";

// Seam 3 of #1: an Agent draws, a person drags it in the browser, the Agent reads the move back.
test("a rectangle an Agent drew can be dragged, undone, redone and deleted in the browser", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId } = (
    await call(request, "kalamo_doc_create", {
      name: "E2E",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  // Centred on the Artboard, which the viewer fits to the centre of the page.
  const created = await call(request, "kalamo_node_create", {
    docId,
    nodes: [{ type: "rect", parentId: defaultLayerId, x: 75, y: 25, width: 50, height: 50 }],
  });
  const [id] = created.structuredContent.createdIds;
  const { rev } = created.structuredContent;

  await page.goto(`/docs/${docId}`);
  // The zoom shows once the Document has arrived and been fitted; pointer input waits for it.
  await expect(page.locator("body")).toContainText(/\d+%/);
  const size = page.viewportSize() ?? { width: 0, height: 0 };
  const [cx, cy] = [size.width / 2, size.height / 2];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 50, cy, { steps: 5 });
  await page.mouse.move(cx + 100, cy, { steps: 5 });
  await page.mouse.up();

  const bounds = async () =>
    // Undefined while the Node is gone: poll callbacks must not throw.
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id] })).structuredContent?.nodes[0]
      .geometricBounds;
  await expect.poll(async () => (await bounds())?.x).toBeGreaterThan(75);
  expect((await bounds())?.y).toBe(25);
  const { changes } = (await call(request, "kalamo_doc_changes", { docId, sinceRev: rev }))
    .structuredContent;
  expect(changes).toMatchObject([{ actor: "user", updatedIds: [id] }]);

  const gone = async () => {
    const result = await call(request, "kalamo_node_get", { docId, nodeIds: [id] });
    return result.isError && JSON.parse(result.content[0].text).code;
  };
  // Undo the drag, then the Agent's create; redo brings the rectangle back (#11).
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await bounds())?.x).toBe(75);
  await page.keyboard.press("Control+z");
  await expect.poll(gone).toBe("NODE_NOT_FOUND");
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => (await bounds())?.x).toBe(75);

  // The redo selects the rectangle again, as it was in the state it restores, so Delete with no
  // click deletes it (ADR-0113).
  await page.keyboard.press("Delete");
  await expect.poll(gone).toBe("NODE_NOT_FOUND");
});

// #10: the Layers panel names an Agent's Nodes live, toggles them, and selects a locked one.
test("the Layers panel shows, hides, locks and selects an Agent's rectangle", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId } = (
    await call(request, "kalamo_doc_create", {
      name: "Layers",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const [id] = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [{ type: "rect", parentId: defaultLayerId, x: 75, y: 25, width: 50, height: 50 }],
    })
  ).structuredContent.createdIds;
  const node = async () =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id] })).structuredContent?.nodes[0];
  const button = (name: string) => page.getByRole("button", { name, exact: true });

  await page.goto(`/docs/${docId}`);
  await expect(page.locator("body")).toContainText(/\d+%/);
  await expect(button("<Rectangle>")).toBeVisible();
  await expect(button("Layer 1")).toBeVisible();

  // An Agent's rename reaches the panel live.
  const { rev } = (
    await call(request, "kalamo_node_update", {
      docId,
      updates: [{ nodeId: id, patch: { name: "Box" } }],
    })
  ).structuredContent;
  await expect(button("Box")).toBeVisible();

  await button("Hide Box").click();
  await expect.poll(async () => (await node())?.visible).toBe(false);
  const { changes } = (await call(request, "kalamo_doc_changes", { docId, sinceRev: rev }))
    .structuredContent;
  expect(changes).toMatchObject([{ actor: "user", updatedIds: [id] }]);
  expect(changes).toHaveLength(1);
  await button("Show Box").click();
  await expect(button("Hide Box")).toBeVisible();

  // Locked: a canvas drag misses it, but its row still selects it; Delete leaves it alone.
  await button("Lock Box").click();
  await expect(button("Unlock Box")).toBeVisible();
  const size = page.viewportSize() ?? { width: 0, height: 0 };
  const [cx, cy] = [size.width / 2, size.height / 2];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy, { steps: 5 });
  await page.mouse.up();
  await button("Box").click();
  await expect(button("Box")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Delete");
  await button("Unlock Box").click();
  await expect(button("Lock Box")).toBeVisible();
  // The socket is ordered: a move or delete sent before the unlock would have committed first.
  await expect.poll(async () => (await node())?.locked).toBe(false);
  expect((await node())?.geometricBounds.x).toBe(75);

  await page.keyboard.press("Delete");
  await expect.poll(async () => (await node()) ?? null).toBeNull();
});

// #4: an Agent's Point Type draws in the bundled font, and the Layers panel names it by content.
test("an Agent's text draws in Source Sans 3", async ({ page, request }) => {
  const { docId, defaultLayerId } = (
    await call(request, "kalamo_doc_create", {
      name: "Text",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  await call(request, "kalamo_node_create", {
    docId,
    nodes: [
      { type: "text", parentId: defaultLayerId, x: 40, y: 70, content: "Hello", fontSize: 48 },
    ],
  });

  await page.goto(`/docs/${docId}`);
  await expect(page.locator("body")).toContainText(/\d+%/);
  await expect(page.getByRole("button", { name: "Hello", exact: true })).toBeVisible();
  // fonts.check() is true when no FontFace matches at all; load() lists the faces it found.
  await expect
    .poll(() =>
      page.evaluate(async () => (await document.fonts.load('12px "Source Sans 3"')).length),
    )
    .toBe(1);
  // #19: every bundled face loads, by its weight and style (ADR-0028).
  await expect
    .poll(() =>
      page.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts]
          .filter((f) => f.family.replace(/"/g, "") === "Source Sans 3")
          .map((f) => `${f.weight} ${f.style} ${f.status}`)
          .sort();
      }),
    )
    .toEqual(["400", "700", "900"].flatMap((w) => [`${w} italic loaded`, `${w} normal loaded`]));
});
