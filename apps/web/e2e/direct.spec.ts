import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #80: Direct Selection moves Anchors and Handles, converts a rect, and Delete opens paths.
test("Direct Selection moves an Anchor, converts a rect, breaks a Handle and deletes Anchors", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "zibel_doc_create", {
      name: "Direct",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const created = await call(request, "zibel_node_create", {
    docId,
    nodes: [
      { type: "rect", parentId, x: 20, y: 10, width: 40, height: 40 },
      // A Smooth Anchor at (110, 60) with Handles at (100, 60) and (120, 60).
      { type: "path", parentId, d: "M 80 90 C 80 70 100 60 110 60 C 120 60 140 70 140 90" },
      { type: "path", parentId, d: "M 150 20 L 190 20 L 190 80 L 150 80" },
    ],
  });
  const [rect, curve, line] = created.structuredContent.createdIds as [string, string, string];
  const get = async (id: string) =>
    (await call(request, "zibel_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent?.nodes[0];

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  // At Actual Size the Artboard's centre (100, 50) stays at the canvas's centre.
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;
  const dragFrom = async (from: [number, number], to: [number, number]) => {
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    await page.mouse.move(...at(...to), { steps: 5 });
    await page.mouse.up();
  };

  await page.keyboard.press("a");
  await expect(page.getByRole("button", { name: "Direct Selection Tool (A)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Dragging one Anchor commits one path_edit Transaction.
  const { rev } = created.structuredContent;
  await dragFrom([190, 20], [190, 10]);
  await expect.poll(async () => (await get(line))?.d).toBe("M 150 20 L 190 10 L 190 80 L 150 80");
  const { changes } = (await call(request, "zibel_doc_changes", { docId, sinceRev: rev }))
    .structuredContent;
  expect(changes).toMatchObject([{ actor: "user", updatedIds: [line] }]);

  // Dragging the rect's corner converts it to a path with the same id.
  await dragFrom([60, 50], [70, 60]);
  await expect
    .poll(async () => await get(rect))
    .toMatchObject({ id: rect, type: "path", d: "M 20 10 L 60 10 L 70 60 L 20 50 Z" });

  // Alt-dragging one Handle of the Smooth Anchor leaves the other where it was: a Corner.
  await page.mouse.click(...at(110, 60));
  await page.keyboard.down("Alt");
  await dragFrom([120, 60], [125, 50]);
  await page.keyboard.up("Alt");
  await expect
    .poll(async () => (await get(curve))?.d)
    .toBe("M 80 90 C 80 70 100 60 110 60 C 125 50 140 70 140 90");

  // A marquee takes an Anchor from each of two paths; Delete opens both there.
  await dragFrom([50, 0], [200, 15]);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await get(rect))?.d).toBe("M 70 60 L 20 50 L 20 10");
  await expect.poll(async () => (await get(line))?.d).toBe("M 190 80 L 150 80");
});
