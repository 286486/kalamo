import { expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

const fill = (color: string) => ({ fills: [{ color }], strokes: [] });
const rect = (x: number, width: number, color: string) => ({
  type: "rect",
  x,
  y: 20,
  width,
  height: 60,
  appearance: fill(color),
});

// #131: an isolated Group keeps its pixels under translucent and blended ancestors (ADR-0057).
test("Isolation Mode draws an isolated Group exactly as the whole Document does", async ({
  page,
  context,
  request,
}) => {
  const { docId, defaultLayerId: layer } = (
    await call(request, "kalamo_doc_create", {
      name: "Isolation compositing",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  // G holds A (20–100), then H, which holds Y (40–70) and B, which holds Blue (60–140), then C
  // (120–150) above them all.
  await call(request, "kalamo_node_create", {
    docId,
    nodes: [
      {
        type: "group",
        parentId: layer,
        name: "G",
        children: [
          { ...rect(20, 80, "#FF0000"), name: "A" },
          {
            type: "group",
            name: "H",
            children: [
              { ...rect(40, 30, "#FFFF00"), name: "Y" },
              {
                type: "group",
                name: "B",
                children: [{ ...rect(60, 80, "#0000FF"), name: "Blue" }],
              },
            ],
          },
          { ...rect(120, 30, "#00FF00"), name: "C" },
        ],
      },
    ],
  });
  type Entry = { id: string; name: string; children?: Entry[] };
  const flat = (es: Entry[]): Entry[] => es.flatMap((e) => [e, ...flat(e.children ?? [])]);
  const { nodes } = (await call(request, "kalamo_doc_outline", { docId, depth: 4 }))
    .structuredContent;
  const id = (name: string) => flat(nodes).find((n) => n.name === name)?.id as string;
  const style = (name: string, patch: object) =>
    call(request, "kalamo_node_update", { docId, updates: [{ nodeId: id(name), patch }] });

  // One tab isolates B; another, not isolated, draws the whole Document to compare with.
  const whole = await context.newPage();
  for (const p of [page, whole]) {
    await p.goto(`/docs/${docId}`);
    await expect(p.getByTestId("status-bar")).toContainText(/\d+%/);
    await p.keyboard.press("Control+1");
    await expect(p.getByTestId("status-bar")).toContainText("100%");
  }
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const bar = page.getByRole("navigation", { name: "Isolation Mode" });
  for (const level of ["G", "H", "B"]) {
    await page.waitForTimeout(600);
    await page.mouse.dblclick(box.x + box.width / 2 + 10, box.y + box.height / 2);
    await expect(bar.locator("[aria-current=location]")).toContainText(level);
  }

  /** Blue over A, over Y and A, and alone; A alone, Y over A, and C alone. */
  const covered = [80, 65, 110];
  const rest = [30, 45, 145];
  const probe = (p: Page, xs: number[]) => Promise.all(xs.map((x) => pixel(p, x, 50)));
  let before = JSON.stringify(await probe(whole, covered));
  const check = async (patches: Record<string, object>) => {
    for (const [name, patch] of Object.entries(patches)) await style(name, patch);
    await expect.poll(async () => JSON.stringify(await probe(whole, covered))).not.toBe(before);
    const expected = await probe(whole, [...covered, ...rest]);
    before = JSON.stringify(expected.slice(0, covered.length));
    // Where B paints, the same pixels; elsewhere the whole Document washed halfway to white.
    await expect.poll(() => probe(page, covered)).toEqual(expected.slice(0, covered.length));
    const washed = await probe(page, rest);
    const off = expected
      .slice(covered.length)
      .flatMap((c, i) => c.map((v, j) => Math.abs((washed[i]?.[j] ?? 0) - (v + 255) / 2)));
    expect(Math.max(...off)).toBeLessThan(1);
    return expected;
  };

  // The issue's scene: G translucent, then multiplied.
  const translucent = await check({ G: { opacity: 0.5 } });
  expect(translucent[0]).toEqual([126, 126, 255]);
  expect(translucent[2]).toEqual([126, 126, 255]);
  // C, above B, is faded under it rather than covering it.
  expect(await pixel(page, 130, 50)).toEqual([126, 126, 255]);
  expect(await pixel(whole, 130, 50)).not.toEqual([126, 126, 255]);
  const multiplied = await check({ G: { opacity: 1, blendMode: "multiply" } });
  expect(multiplied.slice(0, 3)).toEqual([
    [0, 0, 255],
    [0, 0, 255],
    [0, 0, 255],
  ]);
  expect(await pixel(page, 130, 50)).toEqual([0, 0, 255]);
  // Nested: H blends B with A and Y inside G's layer, which is itself translucent.
  const nested = await check({
    G: { opacity: 0.5, blendMode: "normal" },
    H: { opacity: 0.8, blendMode: "multiply" },
  });
  expect(nested[0]).not.toEqual(translucent[0]);
  await check({
    G: { opacity: 0.7, blendMode: "screen" },
    H: { opacity: 1, blendMode: "difference" },
  });
  // A translucent B draws once, at its own opacity.
  await check({
    G: { opacity: 1, blendMode: "normal" },
    H: { blendMode: "normal" },
    B: { opacity: 0.5 },
  });
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
