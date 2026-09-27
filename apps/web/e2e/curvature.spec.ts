import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #82: the Curvature tool draws a closed curve through its clicks, then edits its points.
test("the Curvature tool closes a curve through four clicks, toggles, moves and deletes a point", async ({
  page,
  request,
}) => {
  const { docId, rev } = (
    await call(request, "zibel_doc_create", {
      name: "Curvature",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;
  const path = async () => {
    const [n] = (await call(request, "zibel_node_query", { docId, types: ["path"] }))
      .structuredContent.nodes as { id: string }[];
    if (!n) return null;
    return (await call(request, "zibel_node_get", { docId, nodeIds: [n.id], detail: "full" }))
      .structuredContent.nodes[0] as { id: string; d: string };
  };
  const changes = async () =>
    (await call(request, "zibel_doc_changes", { docId, sinceRev: rev })).structuredContent
      .changes as unknown[];

  await page.keyboard.press("Shift+~");
  await expect(page.getByRole("button", { name: "Curvature Tool (Shift+~)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Four points round a diamond, then the first again closes the curve: one Transaction.
  for (const [x, y] of [
    [60, 50],
    [100, 20],
    [140, 50],
    [100, 80],
    [60, 50],
  ] as const)
    await page.mouse.click(...at(x, y));
  await expect.poll(async () => (await path())?.d).toMatch(/^M 60 50( C( [\d.-]+){6}){4} Z$/);
  expect(await changes()).toHaveLength(1);
  const curve = await path();

  // A double-click on the top point makes it a Corner: one path_edit.
  await page.mouse.dblclick(...at(100, 20));
  await expect.poll(async () => (await changes()).length).toBe(2);
  expect((await path())?.d).toMatch(/ C [\d.-]+ [\d.-]+ 100 20 100 20 C 100 20 /);

  // Dragging the right point moves it; Delete then removes it and the curve stays closed.
  await page.mouse.move(...at(140, 50));
  await page.mouse.down();
  await page.mouse.move(...at(170, 50), { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await path())?.d).toContain(" 170 50 ");
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await path())?.d).not.toContain(" 170 50 ");
  expect((await path())?.id).toBe(curve?.id);
  expect((await path())?.d).toMatch(/^M 60 50 .* Z$/);
});
