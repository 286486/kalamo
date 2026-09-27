import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #74: the Pen draws Corner paths that commit once, in the current Fill and Stroke.
test("the Pen draws a triangle, and an open path that undo takes back", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId, rev } = (
    await call(request, "zibel_doc_create", {
      name: "Pen",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  const size = page.viewportSize() ?? { width: 0, height: 0 };
  const [cx, cy] = [size.width / 2, size.height / 2];
  const paths = async () => {
    const found = (await call(request, "zibel_node_query", { docId, types: ["path"] }))
      .structuredContent.nodes as { id: string }[];
    if (found.length === 0) return [];
    const nodeIds = found.map((n) => n.id);
    return (await call(request, "zibel_node_get", { docId, nodeIds, detail: "full" }))
      .structuredContent.nodes;
  };

  // A red Fill: Fill is the active box, so / sets it to None, then D brings back the default.
  await page.getByRole("button", { name: "Pen Tool (P)" }).click();
  await page.keyboard.press("/");
  await page.keyboard.press("d");
  await page.getByLabel("Fill").fill("#ff0000");

  // Three clicks, then a click on the first Anchor closes the triangle.
  await page.mouse.click(cx - 40, cy + 20);
  await page.mouse.click(cx, cy - 30);
  await page.mouse.click(cx + 40, cy + 20);
  await page.mouse.click(cx - 40, cy + 20);
  await expect.poll(async () => (await paths()).length).toBe(1);
  const [triangle] = await paths();
  expect(triangle).toMatchObject({
    parentId: defaultLayerId,
    appearance: {
      fills: [{ color: "#FF0000" }],
      strokes: [{ color: "#000000", width: 1 }],
    },
  });
  expect(triangle.d).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+ Z$/);
  const { changes } = (await call(request, "zibel_doc_changes", { docId, sinceRev: rev }))
    .structuredContent;
  expect(changes).toMatchObject([{ actor: "user", createdIds: [triangle.id] }]);
  // The new path is the Selection.
  await expect(page.getByRole("button", { name: "<Path>", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Ctrl+Z while drawing removes the last Anchor; Enter commits the rest as one open path.
  await page.mouse.click(cx - 60, cy - 20);
  await page.mouse.click(cx - 50, cy + 30);
  await page.mouse.click(cx + 60, cy + 30);
  await page.keyboard.press("Control+z");
  await page.mouse.click(cx - 20, cy + 40);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await paths()).length).toBe(2);
  const open = (await paths()).find((n: { id: string }) => n.id !== triangle.id);
  expect(open.d).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);

  // Undo after the commit removes the whole path.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await paths()).length).toBe(1);
});

// #78: a drag places a Smooth Anchor, so the path commits as curves.
test("the Pen drags out Smooth Anchors into one curved path", async ({ page, request }) => {
  const { docId } = (
    await call(request, "zibel_doc_create", {
      name: "Curves",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  const size = page.viewportSize() ?? { width: 0, height: 0 };
  const [cx, cy] = [size.width / 2, size.height / 2];
  await page.getByRole("button", { name: "Pen Tool (P)" }).click();
  // Uneven Handles, so no segment is exactly a quadratic, which core would write as Q.
  for (const [x, dx, dy] of [
    [-60, 10, -30],
    [0, 25, 15],
    [60, 10, -20],
  ] as const) {
    await page.mouse.move(cx + x, cy);
    await page.mouse.down();
    await page.mouse.move(cx + x + dx, cy + dy, { steps: 4 });
    await page.mouse.up();
  }
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => {
      const { nodes } = (await call(request, "zibel_node_query", { docId, types: ["path"] }))
        .structuredContent;
      return nodes.length;
    })
    .toBe(1);
  const [{ id }] = (await call(request, "zibel_node_query", { docId, types: ["path"] }))
    .structuredContent.nodes;
  const [path] = (await call(request, "zibel_node_get", { docId, nodeIds: [id], detail: "full" }))
    .structuredContent.nodes;
  expect(path.d).toMatch(/^M [\d.]+ [\d.]+ C( [\d.]+){6} C( [\d.]+){6}$/);
});
