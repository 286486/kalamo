import { expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

/**
 * A new 200 × 100 pt Document open at 100%: `at` maps its points to the page's, `nodes` fetches
 * its Nodes of `types` in full, and `drag` presses at `from`, moves to `to`, presses `keys`, then
 * releases.
 */
async function openShapes(page: Page, request: Parameters<typeof call>[0], name: string) {
  const { docId } = (
    await call(request, "zibel_doc_create", { name, artboards: [{ width: 200, height: 100 }] })
  ).structuredContent;
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;
  const nodes = async <N>(...types: string[]): Promise<N[]> => {
    const found = (await call(request, "zibel_node_query", { docId, types })).structuredContent
      .nodes as { id: string }[];
    if (found.length === 0) return [];
    const nodeIds = found.map((n) => n.id);
    return (await call(request, "zibel_node_get", { docId, nodeIds, detail: "full" }))
      .structuredContent.nodes;
  };
  const drag = async (from: [number, number], to: [number, number], keys: string[] = []) => {
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    await page.mouse.move(...at(...to), { steps: 5 });
    for (const k of keys) await page.keyboard.press(k);
    await page.mouse.up();
  };
  return { at, nodes, drag };
}

/** Picks `name`, a tool without a shortcut, from the Rectangle group's flyout. */
async function pickFromRectangleGroup(page: Page, name: string) {
  await page
    .getByRole("button", { name: "Rectangle Tool (M)", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toHaveAttribute("aria-pressed", "true");
  return button;
}

// #135: the Rectangle and Ellipse tools drag out Live Shapes, one create each.
test("the Rectangle and Ellipse tools drag out Live Shapes with Shift, Alt and Space", async ({
  page,
  request,
}) => {
  const { at, nodes, drag } = await openShapes(page, request, "Shapes");
  const shapes = () =>
    nodes<{ type: string; x: number; y: number; width: number }>("rect", "ellipse");
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
  await drag([100, 80], [101, 81]);
  await page.waitForTimeout(300);
  expect(await shapes()).toHaveLength(1);
});

// #143: the Rounded Rectangle tool's arrow keys change the corner radius during the drag.
test("the Rounded Rectangle tool's arrow keys set the radius, which the next drag keeps", async ({
  page,
  request,
}) => {
  const { nodes, drag } = await openShapes(page, request, "Rounded");
  const rects = () => nodes<{ x: number; radius: number }>("rect");
  const dragAt = (from: number, keys: string[]) => drag([from, 10], [from + 40, 90], keys);

  // No shortcut: the Rectangle group's flyout picks it.
  const button = await pickFromRectangleGroup(page, "Rounded Rectangle Tool");

  // 12 pt, Up twice and Down once: 13. The arrows switch no tool.
  await dragAt(10, ["ArrowUp", "ArrowUp", "ArrowDown"]);
  await expect.poll(rects).toMatchObject([{ x: 10, width: 40, height: 80, radius: 13 }]);
  await expect(button).toHaveAttribute("aria-pressed", "true");
  // The next drag starts at 13; Right rounds it fully, half the 40 pt side.
  await dragAt(60, []);
  await dragAt(110, ["ArrowRight"]);
  await expect
    .poll(async () => (await rects()).map((r) => [r.x, r.radius]))
    .toEqual([
      [10, 13],
      [60, 13],
      [110, 20],
    ]);
  // Left squares the corners.
  await dragAt(160, ["ArrowLeft"]);
  await expect.poll(async () => (await rects()).length).toBe(4);
  expect((await rects()).find((r) => r.x === 160)).toMatchObject({ radius: 0 });
});

// #144: the Polygon tool draws from its centre, turned by the drag, its arrows changing the sides.
test("the Polygon tool drags a Live Polygon from its centre, and Up and Down set its sides", async ({
  page,
  request,
}) => {
  const { nodes, drag } = await openShapes(page, request, "Polygons");
  const polygons = () =>
    nodes<{ cx: number; cy: number; radius: number; sides: number; angle: number }>("polygon");

  const button = await pickFromRectangleGroup(page, "Polygon Tool");

  // Straight down: 6 sides, flat. Then to the left, a quarter turn clockwise, with one side fewer.
  await drag([30, 50], [30, 80]);
  await expect.poll(polygons).toMatchObject([{ cx: 30, cy: 50, radius: 30, sides: 6, angle: 30 }]);
  await drag([120, 50], [100, 50], ["ArrowDown", "ArrowDown", "ArrowUp"]);
  await expect.poll(async () => (await polygons()).length).toBe(2);
  const turned = (await polygons()).find((p) => p.cx === 120);
  expect(turned).toMatchObject({ cy: 50, radius: 20, sides: 5 });
  expect(turned?.angle).toBeCloseTo(90, 6);
  await expect(button).toHaveAttribute("aria-pressed", "true");
  // The count carries over.
  await drag([170, 50], [170, 70]);
  await expect.poll(async () => (await polygons()).length).toBe(3);
  expect((await polygons()).find((p) => p.cx === 170)).toMatchObject({ sides: 5, angle: 0 });
});

// #145: the Star tool draws from its centre, its inner radius half the outer, Up adding a point.
test("the Star tool drags a Live Star from its centre, and Up and Down set its points", async ({
  page,
  request,
}) => {
  const { at, nodes, drag } = await openShapes(page, request, "Stars");
  type Star = {
    cx: number;
    cy: number;
    outerRadius: number;
    innerRadius: number;
    points: number;
    angle: number;
  };
  const stars = () => nodes<Star>("star");

  const button = await pickFromRectangleGroup(page, "Star Tool");

  // Straight down: 5 points, upright. Then to the left, a quarter turn clockwise, with one more.
  await drag([30, 50], [30, 90]);
  await expect
    .poll(stars)
    .toMatchObject([{ cx: 30, cy: 50, outerRadius: 40, innerRadius: 20, points: 5, angle: 0 }]);
  await drag([120, 50], [100, 50], ["ArrowUp", "ArrowUp", "ArrowDown"]);
  await expect.poll(async () => (await stars()).length).toBe(2);
  const turned = (await stars()).find((s) => s.cx === 120);
  expect(turned).toMatchObject({ cy: 50, outerRadius: 20, innerRadius: 10, points: 6 });
  expect(turned?.angle).toBeCloseTo(90, 6);
  await expect(button).toHaveAttribute("aria-pressed", "true");
  // The count carries over.
  await drag([170, 50], [170, 70]);
  await expect.poll(async () => (await stars()).length).toBe(3);
  expect((await stars()).find((s) => s.cx === 170)).toMatchObject({ points: 6, angle: 0 });

  // Ctrl holds the 10 pt inner radius out to 40 pt, and its quarter ratio holds once released.
  await page.mouse.move(...at(75, 50));
  await page.mouse.down();
  await page.mouse.move(...at(75, 70), { steps: 5 });
  await page.keyboard.down("Control");
  await page.mouse.move(...at(75, 90), { steps: 5 });
  await page.keyboard.up("Control");
  await page.mouse.move(...at(75, 70), { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await stars()).length).toBe(4);
  expect((await stars()).find((s) => s.cx === 75)).toMatchObject({
    outerRadius: 20,
    innerRadius: 5,
  });
});
