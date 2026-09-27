import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";
import { choose } from "./menubar.ts";

// #85: Object > Path > Reverse Path Direction, Add Anchor Points and Remove Anchor Points.
test("Object > Path reverses a path, adds Anchors and removes the selected one", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "zibel_doc_create", {
      name: "Path",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const [id] = (
    await call(request, "zibel_node_create", {
      docId,
      nodes: [{ type: "path", parentId, d: "M 20 50 L 100 50 L 180 50" }],
    })
  ).structuredContent.createdIds as [string];
  const d = async () =>
    (await call(request, "zibel_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent?.nodes[0]?.d;

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.locator("canvas").boundingBox();
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
    await call(request, "zibel_doc_create", {
      name: "Join",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const [a, b] = (
    await call(request, "zibel_node_create", {
      docId,
      nodes: [
        { type: "path", parentId, d: "M 20 50 L 80 50" },
        { type: "path", parentId, d: "M 180 50 L 120 50" },
      ],
    })
  ).structuredContent.createdIds as [string, string];
  const node = async (id: string) =>
    (await call(request, "zibel_node_get", { docId, nodeIds: [id], detail: "full" }))
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
