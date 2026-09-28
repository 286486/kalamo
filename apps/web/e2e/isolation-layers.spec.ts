import { expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

const fill = (color: string) => ({ fills: [{ color }], strokes: [] });
const rect = (name: string, x: number, y: number, width: number, height: number, color = "") => ({
  type: "rect",
  name,
  x,
  y,
  width,
  height,
  appearance: color ? fill(color) : undefined,
});

async function open(page: Page, docId: string) {
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  return (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;
}

// #130: Isolation Mode for a sub-Layer and a single path (ADR-0058).
test("Isolation Mode isolates a clipped sub-Layer and a single path", async ({ page, request }) => {
  const { docId, defaultLayerId: layer } = (
    await call(request, "zibel_doc_create", {
      name: "Isolation layers",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const create = async (parentId: string, nodes: object[]) =>
    (
      await call(request, "zibel_node_create", {
        docId,
        nodes: nodes.map((n) => ({ ...n, parentId })),
      })
    ).structuredContent.createdIds as string[];
  const children = async (rootId: string) =>
    (await call(request, "zibel_doc_outline", { docId, rootId, depth: 1 })).structuredContent
      .nodes as { id: string; type: string; name: string }[];
  const get = async (id: string) =>
    (await call(request, "zibel_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent?.nodes[0];
  // Layer 1: Bg, then sub-Layer S: sub-Layer T (T rect), Rect, Group (Group rect), and the
  // unpainted Circle (20–170 × 5–95) clipping S.
  const [, s] = (await create(layer, [
    rect("Bg", 0, 0, 200, 100, "#999999"),
    { type: "layer", name: "S" },
  ])) as [string, string];
  // The Group rect's id follows the Group's.
  const [t, rectId, , , circle] = (await create(s, [
    { type: "layer", name: "T" },
    rect("Rect", 30, 30, 30, 40, "#FF0000"),
    { type: "group", name: "Group", children: [rect("Group rect", 70, 30, 20, 40, "#0000FF")] },
    { type: "ellipse", name: "Circle", x: 20, y: 5, width: 150, height: 90 },
  ])) as [string, string, string, string, string];
  await create(t, [rect("T rect", 130, 40, 20, 20, "#00FF00")]);
  await call(request, "zibel_mask_make", { docId, layerId: s });

  const at = await open(page, docId);
  const bar = page.getByRole("navigation", { name: "Isolation Mode" });
  const current = bar.locator("[aria-current=location]");
  const row = (name: string) => page.getByRole("button", { name, exact: true });
  const enter = page.getByRole("button", { name: /^Enter Isolation Mode/ });
  const bg = await pixel(page, 5, 5);

  // S's row, then Tab to Enter Isolation Mode and Enter.
  await row("S").click();
  await expect(enter).toHaveAccessibleName("Enter Isolation Mode for S");
  for (let i = 0; i < 40 && !(await enter.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press("Tab");
  await expect(enter).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(bar.getByRole("button", { name: "Layer 1" })).toBeVisible();
  await expect(current).toContainText("S");
  await expect(row("Rect")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await pixel(page, 5, 5))[0]).toBeGreaterThan(bg[0] ?? 255);
  await expect(pixel(page, 45, 50)).resolves.toEqual([255, 0, 0]);
  await expect(row("S")).toBeVisible();
  await expect(row("T rect")).toBeVisible();
  await expect(row("Bg")).toBeHidden();
  // Only the bar's crumb names Layer 1.
  await expect(row("Layer 1")).toHaveCount(1);

  // The unpainted Clipping Path drags alone on its outline.
  await page.mouse.move(...at(20, 50));
  await page.mouse.down();
  await page.mouse.move(...at(25, 50), { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await get(circle))?.transform).toEqual([1, 0, 0, 1, 5, 0]);
  expect((await get(rectId))?.transform).toEqual([1, 0, 0, 1, 0, 0]);

  // The Pen draws into S, clipped by the Circle (now 25–175).
  const outside = await pixel(page, 185, 30);
  const paths = async () => (await children(s)).filter((n) => n.type === "path");
  await page.keyboard.press("p");
  for (const [x, y] of [
    [100, 20],
    [195, 20],
    [195, 40],
    [100, 40],
  ] as const)
    await page.mouse.click(...at(x, y));
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await paths()).length).toBe(1);
  await expect.poll(() => pixel(page, 120, 30)).toEqual([255, 255, 255]);
  expect(await pixel(page, 185, 30)).toEqual(outside);
  await expect(current).toContainText("S");
  await page.keyboard.press("v");

  // A Group inside S is a level below S: Esc goes to S, then leaves with nothing selected.
  await page.waitForTimeout(600);
  await page.mouse.dblclick(...at(80, 50));
  await expect(current).toContainText("Group");
  await expect(bar.getByRole("button", { name: "S", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(current).toContainText("S");
  await expect(row("Group")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  await expect(row("Group")).toHaveAttribute("aria-pressed", "false");
  await expect(row("Rect")).toHaveAttribute("aria-pressed", "false");

  // A double-click on the Rect isolates it and selects it; Select All takes only it.
  await page.waitForTimeout(600);
  await page.mouse.dblclick(...at(45, 50));
  await expect(current).toContainText("Rect");
  await expect(bar.getByRole("button", { name: "S", exact: true })).toBeVisible();
  await expect(row("Rect")).toHaveAttribute("aria-pressed", "true");
  await expect(row("Group")).toBeHidden();
  await page.keyboard.press("Control+A");
  await expect(row("Rect")).toHaveAttribute("aria-pressed", "true");
  // The Pen's path goes up one level into S, and is selected.
  const [first] = await paths();
  await page.keyboard.press("p");
  await page.mouse.click(...at(35, 80));
  await page.mouse.click(...at(55, 85));
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await paths()).length).toBe(2);
  await expect(current).toContainText("S");
  const drawn = (await paths()).find((n) => n.id !== first?.id);
  expect(drawn).toBeDefined();
  await expect(
    page.getByRole("button", { name: "<Path>", exact: true, pressed: true }),
  ).toHaveCount(1);
  await expect(row("Rect")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("v");

  // The Rect's row, then Object > Isolate Selected Path from the keyboard alone.
  await row("Rect").click();
  await page.keyboard.press("F10");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const item = page.getByRole("menuitem", { name: "Isolate Selected Path" });
  for (let i = 0; i < 8 && !(await item.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press("ArrowDown");
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(current).toContainText("Rect");
  await expect(row("Rect")).toHaveAttribute("aria-pressed", "true");

  // An Agent deleting the isolated Rect moves the Isolation up to S.
  await call(request, "zibel_node_delete", { docId, nodeIds: [rectId] });
  await expect(current).toContainText("S");
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();

  // A top-level Layer cannot be isolated.
  await row("Layer 1").click();
  await expect(enter).toBeDisabled();
});

// #130: the canvas draws an isolated sub-Layer or leaf in its translucent, clipped Layer.
test("Isolation Mode draws a sub-Layer or leaf as the whole Document does", async ({
  page,
  context,
  request,
}) => {
  const { docId, defaultLayerId: layer } = (
    await call(request, "zibel_doc_create", {
      name: "Isolation layers compositing",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const create = async (parentId: string, nodes: object[]) =>
    (
      await call(request, "zibel_node_create", {
        docId,
        nodes: nodes.map((n) => ({ ...n, parentId })),
      })
    ).structuredContent.createdIds as string[];
  // Layer 1: Bg. Layer P, at 50% and clipped to 0–120: sub-Layer Q with Other (0–15) and Leaf
  // (20–160).
  await create(layer, [rect("Bg", 0, 0, 200, 100, "#999999")]);
  const [p] = (
    await call(request, "zibel_node_create", { docId, nodes: [{ type: "layer", name: "P" }] })
  ).structuredContent.createdIds as [string];
  const [q] = (await create(p, [{ type: "layer", name: "Q" }, rect("P clip", 0, 0, 120, 100)])) as [
    string,
  ];
  await create(q, [
    rect("Other", 0, 20, 15, 60, "#00FF00"),
    rect("Leaf", 20, 20, 140, 60, "#FF0000"),
  ]);
  await call(request, "zibel_mask_make", { docId, layerId: p });
  await call(request, "zibel_node_update", {
    docId,
    updates: [{ nodeId: p, patch: { opacity: 0.5 } }],
  });

  const whole = await context.newPage();
  await open(whole, docId);
  const at = await open(page, docId);
  const bar = page.getByRole("navigation", { name: "Isolation Mode" });
  const probe = (pg: Page, xs: number[]) => Promise.all(xs.map((x) => pixel(pg, x, 50)));
  /** Where the isolated Node covers, the whole Document's pixels; elsewhere, them washed. */
  const check = async (covered: number[], rest: number[]) => {
    const expected = await probe(whole, [...covered, ...rest]);
    await expect.poll(() => probe(page, covered)).toEqual(expected.slice(0, covered.length));
    const washed = await probe(page, rest);
    const off = expected
      .slice(covered.length)
      .flatMap((c, i) => c.map((v, j) => Math.abs((washed[i]?.[j] ?? 0) - (v + 255) / 2)));
    expect(Math.max(...off)).toBeLessThan(1);
  };

  await page.getByRole("button", { name: "Q", exact: true }).click();
  await page.getByRole("button", { name: "Enter Isolation Mode for Q" }).click();
  await expect(bar.locator("[aria-current=location]")).toContainText("Q");
  // Leaf past P's clip (150) draws nothing in Q, so it is washed Bg.
  await check([8, 50], [150]);
  expect(await pixel(whole, 50, 50)).not.toEqual([255, 0, 0]);

  await page.waitForTimeout(600);
  await page.mouse.dblclick(...at(50, 50));
  await expect(bar.locator("[aria-current=location]")).toContainText("Leaf");
  await check([50], [8, 150]);
});

/** The canvas's colour at (x, y) in document coordinates, at 100% with the Artboard centred. */
function pixel(page: Page, x: number, y: number) {
  return page.getByTestId("canvas").evaluate(
    (el: HTMLCanvasElement, [x, y]: [number, number]) => {
      const k = el.width / el.getBoundingClientRect().width;
      const [px, py] = [(el.width / k / 2 + x - 100) * k, (el.height / k / 2 + y - 50) * k];
      return [...(el.getContext("2d")?.getImageData(px, py, 1, 1).data ?? [])].slice(0, 3);
    },
    [x, y] as [number, number],
  );
}
