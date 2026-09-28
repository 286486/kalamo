import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #135: the Rectangle and Ellipse tools drag out Live Shapes, one create each.
test("the Rectangle and Ellipse tools drag out Live Shapes with Shift, Alt and Space", async ({
  page,
  request,
}) => {
  const { docId } = (
    await call(request, "zibel_doc_create", {
      name: "Shapes",
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
  const shapes = async () => {
    const found = (await call(request, "zibel_node_query", { docId, types: ["rect", "ellipse"] }))
      .structuredContent.nodes as { id: string }[];
    if (found.length === 0) return [];
    const nodeIds = found.map((n) => n.id);
    return (await call(request, "zibel_node_get", { docId, nodeIds, detail: "full" }))
      .structuredContent.nodes as { type: string; x: number; y: number; width: number }[];
  };
  const tool = (name: string) => page.getByRole("button", { name, exact: true });

  // M: a plain drag up and left, then Shift pressed with the button still down makes a square.
  await page.keyboard.press("m");
  await expect(tool("Rectangle Tool (M)")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(...at(60, 60));
  await page.mouse.down();
  await page.mouse.move(...at(20, 40), { steps: 5 });
  await page.keyboard.down("Shift");
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect.poll(shapes).toMatchObject([
    {
      type: "rect",
      x: 20,
      y: 20,
      width: 40,
      height: 40,
      appearance: { strokes: [{ width: 1 }] },
    },
  ]);
  await expect(
    page.getByRole("button", { name: "<Rectangle>", exact: true, pressed: true }),
  ).toHaveCount(1);

  // L with Alt: centred on the press; Space held moves it 20 pt right before the release.
  await page.keyboard.press("l");
  await expect(tool("Ellipse Tool (L)")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(...at(120, 50));
  await page.mouse.down();
  await page.keyboard.down("Alt");
  await page.mouse.move(...at(140, 60), { steps: 5 });
  await page.keyboard.down("Space");
  await page.mouse.move(...at(160, 60), { steps: 5 });
  await page.keyboard.up("Space");
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect.poll(async () => (await shapes()).length).toBe(2);
  expect((await shapes()).find((n) => n.type === "ellipse")).toMatchObject({
    x: 120,
    y: 40,
    width: 40,
    height: 20,
  });
  await expect(
    page.getByRole("button", { name: "<Ellipse>", exact: true, pressed: true }),
  ).toHaveCount(1);

  // Undo removes the ellipse in one step; a drag under SLOP draws nothing.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await shapes()).map((n) => n.type)).toEqual(["rect"]);
  await page.mouse.move(...at(100, 80));
  await page.mouse.down();
  await page.mouse.move(...at(101, 81));
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await shapes()).toHaveLength(1);
});
