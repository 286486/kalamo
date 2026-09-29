import { expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

/**
 * A new 200 × 100 pt Document open at 100%: `at` maps its points to the page's, `nodes` fetches
 * its Nodes of `types` in full, and `drag` presses at `from`, takes each step, then releases. A
 * step is a point to move to, a key to press, or `+Key` and `-Key` to hold one down and let it up.
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
  const drag = async (from: [number, number], ...steps: ([number, number] | string)[]) => {
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    for (const step of steps) {
      if (typeof step !== "string") await page.mouse.move(...at(...step), { steps: 5 });
      else if (step.startsWith("+")) await page.keyboard.down(step.slice(1));
      else if (step.startsWith("-")) await page.keyboard.up(step.slice(1));
      else await page.keyboard.press(step);
    }
    await page.mouse.up();
  };
  return { nodes, drag };
}

/** Picks `name`, a tool without a shortcut, from the flyout of the group whose button is `group`. */
async function pickFromGroup(page: Page, group: string, name: string) {
  await page.getByRole("button", { name: group, exact: true }).click({ button: "right" });
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toHaveAttribute("aria-pressed", "true");
  return button;
}

const LINE_GROUP = "Line Segment Tool (\\)";

// #135: the Rectangle and Ellipse tools drag out Live Shapes, one create each.
test("the Rectangle and Ellipse tools drag out Live Shapes with Shift, Alt and Space", async ({
  page,
  request,
}) => {
  const { nodes, drag } = await openShapes(page, request, "Shapes");
  const shapes = () =>
    nodes<{ type: string; x: number; y: number; width: number }>("rect", "ellipse");
  const tool = (name: string) => page.getByRole("button", { name, exact: true });

  // M: a plain drag up and left, then Shift pressed with the button still down makes a square.
  await page.keyboard.press("m");
  await expect(tool("Rectangle Tool (M)")).toHaveAttribute("aria-pressed", "true");
  await drag([60, 60], [20, 40], "+Shift");
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
  await drag([120, 50], "+Alt", [140, 60], "+Space", [160, 60], "-Space");
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
  const dragAt = (from: number, ...keys: string[]) => drag([from, 10], [from + 40, 90], ...keys);

  // No shortcut: the Rectangle group's flyout picks it.
  const button = await pickFromGroup(page, "Rectangle Tool (M)", "Rounded Rectangle Tool");

  // 12 pt, Up twice and Down once: 13. The arrows switch no tool.
  await dragAt(10, "ArrowUp", "ArrowUp", "ArrowDown");
  await expect.poll(rects).toMatchObject([{ x: 10, width: 40, height: 80, radius: 13 }]);
  await expect(button).toHaveAttribute("aria-pressed", "true");
  // The next drag starts at 13; Right rounds it fully, half the 40 pt side.
  await dragAt(60);
  await dragAt(110, "ArrowRight");
  await expect
    .poll(async () => (await rects()).map((r) => [r.x, r.radius]))
    .toEqual([
      [10, 13],
      [60, 13],
      [110, 20],
    ]);
  // Left squares the corners.
  await dragAt(160, "ArrowLeft");
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

  const button = await pickFromGroup(page, "Rectangle Tool (M)", "Polygon Tool");

  // Straight down: 6 sides, flat. Then to the left, a quarter turn clockwise, with one side fewer.
  await drag([30, 50], [30, 80]);
  await expect.poll(polygons).toMatchObject([{ cx: 30, cy: 50, radius: 30, sides: 6, angle: 30 }]);
  await drag([120, 50], [100, 50], "ArrowDown", "ArrowDown", "ArrowUp");
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
  const { nodes, drag } = await openShapes(page, request, "Stars");
  type Star = {
    cx: number;
    cy: number;
    outerRadius: number;
    innerRadius: number;
    points: number;
    angle: number;
  };
  const stars = () => nodes<Star>("star");

  const button = await pickFromGroup(page, "Rectangle Tool (M)", "Star Tool");

  // Straight down: 5 points, upright. Then to the left, a quarter turn clockwise, with one more.
  await drag([30, 50], [30, 90]);
  await expect
    .poll(stars)
    .toMatchObject([{ cx: 30, cy: 50, outerRadius: 40, innerRadius: 20, points: 5, angle: 0 }]);
  await drag([120, 50], [100, 50], "ArrowUp", "ArrowUp", "ArrowDown");
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
  await drag([75, 50], [75, 70], "+Control", [75, 90], "-Control", [75, 70]);
  await expect.poll(async () => (await stars()).length).toBe(4);
  expect((await stars()).find((s) => s.cx === 75)).toMatchObject({
    outerRadius: 20,
    innerRadius: 5,
  });
});

// #146: the Line Segment tool draws a Live Line in the current Stroke and no Fill.
test("the Line Segment tool drags a Live Line with Shift and Alt, stroked and unfilled", async ({
  page,
  request,
}) => {
  const { nodes, drag } = await openShapes(page, request, "Lines");
  type Line = { x1: number; y1: number; x2: number; y2: number; appearance: object };
  const lines = () => nodes<Line>("line");

  // \ picks it; the default Fill box is set, and the line still has no Fill.
  await page.keyboard.press("\\");
  await expect(
    page.getByRole("button", { name: "Line Segment Tool (\\)", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await drag([20, 80], [80, 20]);
  await expect
    .poll(lines)
    .toMatchObject([
      { x1: 20, y1: 80, x2: 80, y2: 20, appearance: { fills: [], strokes: [{ width: 1 }] } },
    ]);

  // Shift turns it to 0°; Alt centres it on the press.
  await drag([100, 50], [150, 54], "+Shift");
  await page.keyboard.up("Shift");
  await drag([60, 50], "+Alt", [80, 60]);
  await page.keyboard.up("Alt");
  await expect.poll(async () => (await lines()).length).toBe(3);
  const all = await lines();
  expect(all.find((l) => l.x1 === 100)).toMatchObject({ y1: 50, x2: 150, y2: 50 });
  expect(all.find((l) => l.x2 === 80 && l.y2 === 60)).toMatchObject({ x1: 40, y1: 40 });

  // A drag back to its press draws nothing.
  await drag([100, 80], [120, 80], [100, 80]);
  await page.waitForTimeout(300);
  expect(await lines()).toHaveLength(3);
});

// #147: the Arc tool draws a plain Path (ADR-0059), open and unfilled or closed and filled.
test("the Arc tool drags an arc Path whose keys change it without switching tools", async ({
  page,
  request,
}) => {
  const { nodes, drag } = await openShapes(page, request, "Arcs");
  type Arc = { d: string; appearance: { fills: object[]; strokes: object[] } };
  const arcs = () => nodes<Arc>("path");

  // It has no shortcut: the Line Segment group's flyout picks it.
  const button = await pickFromGroup(page, LINE_GROUP, "Arc Tool");

  // Open, X Axis, slope 50: the current Stroke and no Fill.
  await drag([20, 20], [60, 80]);
  await expect
    .poll(arcs)
    .toMatchObject([
      { d: "M 20 20 C 20 50 40 80 60 80", appearance: { fills: [], strokes: [{ width: 1 }] } },
    ]);

  // Up, X, F and C change it and switch no tool; closed, it takes the Fill too.
  await drag([100, 20], [140, 80], "ArrowUp", "X", "F", "C", [140, 80]);
  await expect.poll(async () => (await arcs()).length).toBe(2);
  await expect(button).toHaveAttribute("aria-pressed", "true");
  expect((await arcs()).find((a) => a.d.startsWith("M 100 20"))).toMatchObject({
    d: "M 100 20 C 100 50.6 119.6 80 140 80 L 100 80 Z",
    appearance: { fills: [{}], strokes: [{ width: 1 }] },
  });
});

// #149: the Spiral tool draws a Live Spiral (ADR-0060) from its centre, its outer end at the pointer.
test("the Spiral tool drags a Live Spiral whose winds and decay carry over", async ({
  page,
  request,
}) => {
  const { nodes, drag } = await openShapes(page, request, "Spirals");
  type Spiral = {
    cx: number;
    cy: number;
    radius: number;
    revolution: number;
    expansion: number;
    argument: number;
    t0: number;
    d: string;
    appearance: { fills: object[]; strokes: object[] };
  };
  const spirals = () => nodes<Spiral>("spiral");
  const at = async (cx: number) => (await spirals()).find((s) => s.cx === cx);

  const button = await pickFromGroup(page, LINE_GROUP, "Spiral Tool");

  // Straight down: 10 segments at 80%, 2.5 turns at expansion 1, in the current Fill and Stroke.
  await drag([100, 50], [100, 80]);
  await expect.poll(spirals).toMatchObject([
    {
      cx: 100,
      cy: 50,
      radius: 30,
      revolution: 2.5,
      expansion: 1,
      argument: 270,
      t0: 0,
      d: expect.stringMatching(/^M 100 50 C .* 100 80$/),
      appearance: { fills: [{}], strokes: [{ width: 1 }] },
    },
  ]);

  // Up adds a segment; Ctrl at half the 20 pt drawn halves the decay to 40%, keeping the radius.
  await drag([40, 50], [40, 70], "ArrowUp", "+Control", [40, 60], [40, 60]);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await spirals()).length).toBe(2);
  const decayed = await at(40);
  expect(decayed).toMatchObject({ radius: 20, revolution: 2.75, argument: 180 });
  expect(decayed?.expansion).toBeCloseTo(Math.log(0.4) / Math.log(0.8), 6);
  await expect(button).toHaveAttribute("aria-pressed", "true");

  // Both carry over; to the right, the outer end points right.
  await drag([160, 50], [180, 50]);
  await expect.poll(async () => (await spirals()).length).toBe(3);
  const kept = await at(160);
  expect(kept).toMatchObject({ radius: 20, revolution: 2.75, argument: 90 });
  expect(kept?.expansion).toBeCloseTo(Math.log(0.4) / Math.log(0.8), 6);
});

// #150: the Rectangular Grid tool draws a Group of a frame and divider lines (ADR-0061).
test("the Rectangular Grid tool drags a Group whose divider counts and skews carry over", async ({
  page,
  request,
}) => {
  const { nodes, drag } = await openShapes(page, request, "Grids");
  type Line = { parentId: string; x1: number; y1: number; x2: number; y2: number };
  const groups = () => nodes<{ id: string; appearance?: object }>("group");
  const rects = () => nodes<{ parentId: string; x: number; y: number; width: number }>("rect");
  const lines = async (group: string) =>
    (await nodes<Line>("line")).filter((l) => l.parentId === group);
  // node_query sorts by id: the positions, sorted, top down and from the left.
  const horizontal = async (group: string) =>
    (await lines(group))
      .filter((l) => l.y1 === l.y2)
      .map((l) => l.y1)
      .sort((a, b) => a - b);
  const vertical = async (group: string) =>
    (await lines(group))
      .filter((l) => l.x1 === l.x2)
      .map((l) => l.x1)
      .sort((a, b) => a - b);

  const expectClose = (actual: number[], expected: number[]) => {
    expect(actual).toHaveLength(expected.length);
    for (const [i, v] of actual.entries()) expect(v).toBeCloseTo(expected[i] as number, 6);
  };

  const button = await pickFromGroup(page, LINE_GROUP, "Rectangular Grid Tool");

  // 5 and 5 dividers, evenly spaced in a 60 pt frame, all in the Stroke alone.
  await drag([20, 20], [80, 80]);
  await expect.poll(async () => (await groups()).length).toBe(1);
  const [first] = await groups();
  const id = first?.id as string;
  expect(first?.appearance).toMatchObject({ fills: [], strokes: [] });
  expect(await rects()).toMatchObject([
    { parentId: id, x: 20, y: 20, width: 60, appearance: { fills: [], strokes: [{ width: 1 }] } },
  ]);
  expect(await horizontal(id)).toEqual([30, 40, 50, 60, 70]);
  expect(await vertical(id)).toEqual([30, 40, 50, 60, 70]);
  // The Group is selected, not its children.
  await expect(
    page.getByRole("button", { name: "<Group>", exact: true, pressed: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "<Line>", exact: true, pressed: true }),
  ).toHaveCount(0);

  // Up and Left: 6 horizontal, 4 vertical. V and C skew each 10% toward the top and the right.
  await drag([100, 10], [170, 80], "ArrowUp", "ArrowLeft", "v", "c", "v", "f");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await groups()).length).toBe(2);
  const second = (await groups()).find((g) => g.id !== id)?.id as string;
  // n dividers at `skew`%: each cell 2^(−skew/100) times the one before (ADR-0061).
  const at = (n: number, skew: number) => {
    const q = 2 ** (-skew / 100);
    return Array.from({ length: n }, (_, i) => (1 - q ** (i + 1)) / (1 - q ** (n + 1)));
  };
  const ys = at(6, 10)
    .map((f) => 80 - f * 70)
    .reverse();
  expectClose(await horizontal(second), ys);
  const xs = at(4, 10).map((f) => 100 + f * 70);
  expectClose(await vertical(second), xs);

  // Undo removes the second grid, frame and dividers, in one step.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await groups()).map((g) => g.id)).toEqual([id]);
  expect(await lines(second)).toEqual([]);
  expect((await rects()).map((r) => r.parentId)).toEqual([id]);

  // The counts and skews carry over to the next drag.
  await drag([100, 10], [170, 80]);
  await expect.poll(async () => (await groups()).length).toBe(2);
  const third = (await groups()).find((g) => g.id !== id)?.id as string;
  expect(await horizontal(third)).toHaveLength(6);
  expectClose(await vertical(third), xs);
});
