import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";
import { choose } from "./menubar.ts";

// #85: Object > Path > Reverse Path Direction, Add Anchor Points and Remove Anchor Points.
test("Object > Path reverses a path, adds Anchors and removes the selected one", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Path",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const [id] = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [{ type: "path", parentId, d: "M 20 50 L 100 50 L 180 50" }],
    })
  ).structuredContent.createdIds as [string];
  const d = async () =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent?.nodes[0]?.d;

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;

  await page.keyboard.press("Control+a");
  await choose(page, "Object", "Path", "Reverse Path Direction");
  await expect.poll(d).toBe("M 180 50 L 100 50 L 20 50");
  await choose(page, "Object", "Path", "Add Anchor Points");
  await expect.poll(d).toBe("M 180 50 L 140 50 L 100 50 L 60 50 L 20 50");

  // Direct Selection takes the middle Anchor; removing it keeps the path joined.
  await page.keyboard.press("a");
  await page.mouse.click(...at(100, 50));
  await choose(page, "Object", "Path", "Remove Anchor Points");
  await expect.poll(d).toBe("M 180 50 L 140 50 L 60 50 L 20 50");
});

// #84: Object > Path > Join (Ctrl+J) and Average… (Alt+Ctrl+J).
test("Join makes two open paths one and closes one alone; Average stacks Anchors", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Join",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const [a, b] = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [
        { type: "path", parentId, d: "M 20 50 L 80 50" },
        { type: "path", parentId, d: "M 180 50 L 120 50" },
      ],
    })
  ).structuredContent.createdIds as [string, string];
  const node = async (id: string) =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent?.nodes[0];

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+a");
  await choose(page, "Object", "Path", "Join");
  await expect.poll(async () => (await node(b))?.d).toBe("M 180 50 L 120 50 L 80 50 L 20 50");
  expect(await node(a)).toBeUndefined();
  // Undo brings both back: one Transaction.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await node(a))?.d).toBe("M 20 50 L 80 50");
  await page.keyboard.press("Shift+Control+z");
  await expect.poll(async () => (await node(a))?.d).toBeUndefined();

  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+j");
  await expect.poll(async () => (await node(b))?.d).toBe("M 180 50 L 120 50 L 80 50 L 20 50 Z");

  await page.keyboard.press("Control+a");
  await page.keyboard.press("Alt+Control+j");
  const dialog = page.getByRole("dialog", { name: "Average" });
  await dialog.getByLabel("Horizontal").check();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await choose(page, "Object", "Path", "Average…");
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect.poll(async () => (await node(b))?.d).toBe("M 100 50 L 100 50 L 100 50 L 100 50 Z");
});

// #86: Object > Path > Simplify….
test("Simplify previews on its bar and commits once on OK; More Options converts to lines", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Simplify",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const points = Array.from(
    { length: 200 },
    (_, i) => `${i} ${Math.round(50e3 + 30e3 * Math.sin(i / 15)) / 1e3}`,
  );
  const original = `M ${points.join(" L ")}`;
  const [id] = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [{ type: "path", parentId, d: original }],
    })
  ).structuredContent.createdIds as [string];
  const d = async () =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent?.nodes[0]?.d as string;
  const segments = async () => (await d()).match(/[LC]/g)?.length ?? 0;

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+a");
  await choose(page, "Object", "Path", "Simplify…");
  const bar = page.getByRole("toolbar", { name: "Simplify" });
  await bar.getByLabel("Simplify Curve").fill("20");
  // Only a preview: nothing is sent until OK, and Cancel drops it.
  await bar.getByRole("button", { name: "Cancel" }).click();
  await expect(bar).toBeHidden();
  expect(await d()).toBe(original);

  await choose(page, "Object", "Path", "Simplify…");
  await bar.getByRole("button", { name: "OK" }).click();
  await expect.poll(segments).toBeLessThan(20);
  // One Transaction: one Undo brings every Anchor back.
  await page.keyboard.press("Control+z");
  await expect.poll(d).toBe(original);

  await page.keyboard.press("Control+a");
  await choose(page, "Object", "Path", "Simplify…");
  await bar.getByRole("button", { name: "More Options" }).click();
  const dialog = page.getByRole("dialog", { name: "Simplify" });
  await expect(dialog).toContainText("Original: 200 Anchors");
  await dialog.getByLabel("Convert to Straight Lines").check();
  await dialog.getByLabel("Show Original Path").check();
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect.poll(d).toMatch(/^M [\d. ]+( L [\d. ]+)+$/);
  expect(await segments()).toBeLessThan(60);
});

// #310: the dialog counts the path the canvas draws, and an Agent's change recounts it.
test("Simplify's dialog recounts its Anchors when an Agent reshapes the path", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Simplify",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const wave = (n: number) =>
    `M ${Array.from({ length: n }, (_, i) => `${i} ${50 + Math.round(300 * Math.sin(i / 15)) / 10}`).join(" L ")}`;
  const [id] = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [{ type: "path", parentId, d: wave(200) }],
    })
  ).structuredContent.createdIds as [string];

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+a");
  await choose(page, "Object", "Path", "Simplify…");
  await page
    .getByRole("toolbar", { name: "Simplify" })
    .getByRole("button", { name: "More Options" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Simplify" });
  await expect(dialog).toContainText("Original: 200 Anchors");

  await call(request, "kalamo_path_edit", {
    docId,
    nodeId: id,
    ops: [{ op: "set_d", d: "M 0 50 L 100 20 L 150 80" }],
  });
  await expect(dialog).toContainText("Original: 3 Anchors · Current: 3 Anchors");
});

// #88: Object > Path > Offset Path….
test("Offset Path previews the copy, adds it below on OK, and one Undo takes it away", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Offset",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const [id] = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [
        {
          type: "rect",
          parentId,
          x: 50,
          y: 25,
          width: 100,
          height: 50,
          appearance: { fills: [{ color: "#FF0000" }] },
        },
      ],
    })
  ).structuredContent.createdIds as [string];
  // The Layer's children, bottom to top.
  const layer = async () =>
    (await call(request, "kalamo_doc_outline", { docId, rootId: parentId, depth: 1 }))
      .structuredContent?.nodes as { id: string }[];

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  // Red at 5 pt left of the rect, inside where a 10 pt offset reaches.
  const red = () =>
    page.getByTestId("canvas").evaluate((el: HTMLCanvasElement) => {
      const k = el.width / el.getBoundingClientRect().width;
      const [x, y] = [(el.width / k / 2 - 55) * k, (el.height / k / 2) * k];
      return el.getContext("2d")?.getImageData(x, y, 1, 1).data[1] === 0;
    });
  expect(await red()).toBe(false);

  await page.keyboard.press("Control+a");
  await choose(page, "Object", "Path", "Offset Path…");
  const dialog = page.getByRole("dialog", { name: "Offset Path" });
  await expect(dialog.getByLabel("Offset")).toHaveValue("10");
  await expect(dialog.getByLabel("Miter limit")).toHaveValue("4");
  await dialog.getByLabel("Preview").check();
  await expect.poll(red).toBe(true);
  // Only a preview: Cancel sends nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(red).toBe(false);
  expect(await layer()).toHaveLength(1);

  await choose(page, "Object", "Path", "Offset Path…");
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect.poll(async () => (await layer()).map((n) => n.id === id)).toEqual([false, true]);
  expect(await red()).toBe(true);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await layer()).length).toBe(1);
});

// #89: Object > Path > Split Into Grid… and Clean Up….
test("Split Into Grid replaces the rect with a grid, and Clean Up says how many it removed", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Grid",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  await call(request, "kalamo_node_create", {
    docId,
    nodes: [
      { type: "rect", parentId, x: 0, y: 0, width: 200, height: 100 },
      { type: "path", parentId, d: "M 5 5" },
    ],
  });
  const layer = async () =>
    (await call(request, "kalamo_doc_outline", { docId, rootId: parentId, depth: 1 }))
      .structuredContent?.nodes as { type: string }[];

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+a");
  await choose(page, "Object", "Path", "Split Into Grid…");
  const dialog = page.getByRole("dialog", { name: "Split Into Grid" });
  await dialog.getByLabel("Columns:", { exact: true }).fill("3");
  await dialog.getByLabel("Gutter").fill("10");
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect
    .poll(async () => (await layer()).map((n) => n.type))
    .toEqual(["rect", "rect", "rect", "rect", "rect", "rect", "path"]);

  await choose(page, "Object", "Path", "Clean Up…");
  await page.getByRole("dialog", { name: "Clean Up" }).getByRole("button", { name: "OK" }).click();
  await expect(page.getByText("Clean Up removed 1 object(s).")).toBeVisible();
  await expect.poll(async () => (await layer()).length).toBe(6);
});
