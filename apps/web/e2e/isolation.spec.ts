import { expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

const fill = (color: string) => ({ fills: [{ color }], strokes: [] });

// #53: Isolation Mode (ADR-0057).
test("Isolation Mode enters, edits inside, navigates and leaves a Clip Group", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: layer } = (
    await call(request, "zibel_doc_create", {
      name: "Isolation",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const create = async (nodes: object[]) =>
    (await call(request, "zibel_node_create", { docId, nodes })).structuredContent
      .createdIds as string[];
  const mask = async (clipNodeId: string, contentIds: string[], name: string) => {
    const [id] = (await call(request, "zibel_mask_make", { docId, clipNodeId, contentIds }))
      .structuredContent.createdIds as [string];
    await call(request, "zibel_node_update", { docId, updates: [{ nodeId: id, patch: { name } }] });
    return id;
  };
  const rect = (name: string, x: number, y: number, width: number, height: number, color = "") => ({
    type: "rect",
    parentId: layer,
    name,
    x,
    y,
    width,
    height,
    appearance: color ? fill(color) : undefined,
  });
  // Layer 1: Bg, then Clip Group Outer: Content (20–100) clipped to Clip (30–90 × 20–80), and a
  // Clip Group Inner (50–70 × 40–60).
  const [, content, clip, innerContent, innerClip] = (await create([
    rect("Bg", 0, 0, 200, 100, "#999999"),
    rect("Content", 20, 10, 80, 80, "#FF0000"),
    rect("Clip", 30, 20, 60, 60),
    rect("Inner content", 50, 40, 20, 20, "#0000FF"),
    rect("Inner clip", 50, 40, 20, 20),
  ])) as [string, string, string, string, string];
  const inner = await mask(innerClip, [innerContent], "Inner");
  const outer = await mask(clip, [content, inner], "Outer");
  // Layer 2 above: Clip Group Wide (110–190) inside a Layer Clipping Mask (120–160).
  const [layer2] = await create([{ type: "layer", name: "Layer 2" }]);
  const [wideContent, wideClip] = (await create(
    [
      rect("Wide content", 110, 20, 80, 60, "#00FF00"),
      rect("Wide clip", 110, 20, 80, 60),
      rect("Layer clip", 120, 0, 40, 100),
    ].map((n) => ({ ...n, parentId: layer2 })),
  )) as [string, string, string];
  await mask(wideClip, [wideContent], "Wide");
  await call(request, "zibel_mask_make", { docId, layerId: layer2 });

  const get = async (id: string) =>
    (await call(request, "zibel_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent?.nodes[0];

  // Two Document Tabs, the second opened from the list, then back to the first in place.
  const { docId: other } = (
    await call(request, "zibel_doc_create", {
      name: "Isolation other",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  await page.goto(`/docs/${docId}`);
  // The tab bar saves the tabs only once it renders; leaving earlier loses this tab (#169).
  await expect(page.getByRole("tab", { name: "Isolation", exact: true })).toBeVisible();
  await page.goto("/");
  await page.locator(`a[href="/docs/${other}"]`).click();
  await page.getByRole("tab", { name: "Isolation", exact: true }).click();
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;
  const bar = page.getByRole("navigation", { name: "Isolation Mode" });
  const row = (name: string) => page.getByRole("button", { name, exact: true });
  await expect(pixel(page, 40, 30)).resolves.toEqual([255, 0, 0]);
  const bg = await pixel(page, 5, 5);

  // A double-click on the content isolates Outer and selects the content.
  await page.mouse.dblclick(...at(40, 30));
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button", { name: "Layer 1" })).toBeVisible();
  await expect(bar.locator("[aria-current=location]")).toContainText("Outer");
  await expect(row("Content")).toHaveAttribute("aria-pressed", "true");
  // The rest fades toward white; the isolated Group draws as it did.
  await expect.poll(async () => (await pixel(page, 5, 5))[0]).toBeGreaterThan(bg[0] ?? 255);
  await expect(pixel(page, 40, 30)).resolves.toEqual([255, 0, 0]);
  // The Layers panel lists only Outer and what is in it.
  await expect(row("Outer")).toBeVisible();
  await expect(row("Bg")).toBeHidden();
  await expect(row("Layer 2")).toBeHidden();

  // The unpainted Clipping Path drags alone on its outline.
  await page.mouse.move(...at(30, 50));
  await page.mouse.down();
  await page.mouse.move(...at(35, 50), { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await get(clip))?.transform).toEqual([1, 0, 0, 1, 5, 0]);
  expect((await get(content))?.transform).toEqual([1, 0, 0, 1, 0, 0]);

  // Select All takes only what is in Outer.
  await page.keyboard.press("Control+A");
  for (const name of ["Content", "Clip", "Inner"])
    await expect(row(name)).toHaveAttribute("aria-pressed", "true");

  // One level deeper, then the Layer's crumb leaves and selects Outer.
  await page.waitForTimeout(600);
  await page.mouse.dblclick(...at(60, 50));
  await expect(bar.locator("[aria-current=location]")).toContainText("Inner");
  await expect(row("Inner content")).toHaveAttribute("aria-pressed", "true");
  await bar.getByRole("button", { name: "Layer 1" }).click();
  await expect(bar).toBeHidden();
  await expect(row("Outer")).toHaveAttribute("aria-pressed", "true");

  // Object > Isolate Selected Group from the keyboard alone.
  await page.keyboard.press("F10");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const isolateItem = page.getByRole("menuitem", { name: "Isolate Selected Group" });
  for (
    let i = 0;
    i < 6 && !(await isolateItem.evaluate((el) => el === document.activeElement));
    i++
  )
    await page.keyboard.press("ArrowDown");
  await expect(isolateItem).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(bar.locator("[aria-current=location]")).toContainText("Outer");

  // Esc leaves the Zoom tool first.
  await page.keyboard.press("z");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Selection Tool (V)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(bar).toBeVisible();

  // The Pen draws into Outer, clipped; Esc finishes the path first, then goes up.
  await page.keyboard.press("p");
  await page.mouse.click(...at(40, 30));
  await page.mouse.click(...at(80, 30));
  await page.mouse.click(...at(80, 70));
  await page.keyboard.press("Escape");
  const drawn = async () =>
    (
      await call(request, "zibel_doc_outline", { docId, rootId: outer, depth: 1 })
    ).structuredContent.nodes.filter((n: { type: string }) => n.type === "path");
  await expect.poll(async () => (await drawn()).length).toBe(1);
  await expect(bar).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  await page.keyboard.press("v");

  // Another Document Tab and back keeps the Isolation; a reload clears it.
  await page.waitForTimeout(600);
  await page.mouse.dblclick(...at(40, 30));
  await expect(bar).toBeVisible();
  await page.getByRole("tab", { name: "Isolation other" }).click();
  await expect(page).toHaveURL(`/docs/${other}`);
  await expect(bar).toBeHidden();
  await page.getByRole("tab", { name: "Isolation", exact: true }).click();
  await expect(bar).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await expect(page.getByRole("tab", { name: "Isolation", exact: true })).toBeVisible();
  await expect(bar).toBeHidden();

  // An Agent deleting the isolated Group ends Isolation Mode.
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  await page.mouse.dblclick(...at(40, 30));
  await expect(bar).toBeVisible();
  await call(request, "zibel_node_delete", { docId, nodeIds: [outer] });
  await expect(bar).toBeHidden();

  // Inside a Layer Clipping Mask the isolated Group stays clipped by the Layer too.
  await page.waitForTimeout(600);
  await page.mouse.dblclick(...at(140, 50));
  await expect(bar.locator("[aria-current=location]")).toContainText("Wide");
  await expect(bar.getByRole("button", { name: "Layer 2" })).toBeVisible();
  await expect(pixel(page, 140, 50)).resolves.toEqual([0, 255, 0]);
  expect((await pixel(page, 115, 50))[1]).not.toBe(255);
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
