import { expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

/** Noto Sans SC's files, which only a Document that draws in it may request (ADR-0063). */
const noto = (page: Page) => {
  const urls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("NotoSansSC")) urls.push(r.url());
  });
  return urls;
};

/** The first and last columns holding ink in row band `top` to `bottom`, in pt from the left, at `k` px per pt. */
function inkColumns(
  { width, data }: { width: number; data: ArrayLike<number> },
  top: number,
  bottom: number,
  k = 1,
): [number, number] {
  let [left, right] = [Infinity, -Infinity];
  for (let y = Math.round(top * k); y < Math.round(bottom * k); y++) {
    // 2 pt in from each side, past the canvas's Artboard edge.
    for (let x = Math.round(2 * k); x < width - Math.round(2 * k); x++) {
      const i = (y * width + x) * 4;
      if ((data[i] ?? 255) < 128) [left, right] = [Math.min(left, x), Math.max(right, x)];
    }
  }
  return [left / k, (right + 1) / k];
}

async function textDoc(page: Page, request: Parameters<typeof call>[0], text: object) {
  const { docId, defaultLayerId } = (
    await call(request, "zibel_doc_create", {
      name: "CJK",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const { createdIds } = (
    await call(request, "zibel_node_create", {
      docId,
      nodes: [{ type: "text", parentId: defaultLayerId, x: 20, y: 70, fontSize: 48, ...text }],
    })
  ).structuredContent;
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  return { docId, id: createdIds[0] as string };
}

// #159: CJK draws in Noto Sans SC, loaded lazily, measured as `render` draws it (ADR-0063).
test("a CJK text loads Noto Sans SC and draws its glyphs inside the bounds render draws", async ({
  page,
  request,
}) => {
  const requested = noto(page);
  const { docId, id } = await textDoc(page, request, {
    content: "小动物",
    fontStyle: "Bold Italic",
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts]
          .filter((f) => f.family.replace(/"/g, "") === "Noto Sans SC")
          .map((f) => `${f.weight} ${f.style} ${f.status}`)
          .sort(),
      ),
    )
    .toEqual(["400", "700"].flatMap((w) => [`${w} italic loaded`, `${w} normal loaded`]));
  expect(requested).toHaveLength(2);

  const b = (await call(request, "zibel_node_get", { docId, nodeIds: [id] })).structuredContent
    .nodes[0].geometricBounds;
  expect(b.width).toBeCloseTo(3 * 48);
  // The Artboard's centre, (100, 50), is the canvas's at 100%.
  const canvas = () =>
    page.getByTestId("canvas").evaluate((el: HTMLCanvasElement) => {
      const k = el.width / el.getBoundingClientRect().width;
      const [x, y] = [el.width / 2 - 100 * k, el.height / 2 - 50 * k];
      const pixels = el.getContext("2d")?.getImageData(x, y, 200 * k, 100 * k);
      return { k, width: pixels?.width ?? 0, data: [...(pixels?.data ?? [])] };
    });
  const rendered = await call(request, "zibel_render", {
    docId,
    scope: { rect: { x: 0, y: 0, width: 200, height: 100 } },
    scale: 1,
    background: "#FFFFFF",
  });
  const png = rendered.content.find((c: { type: string }) => c.type === "image").data as string;
  // Decoded in the page: its canvas reads a PNG's pixels.
  const image = await page.evaluate(async (png) => {
    const bitmap = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${png}`)).blob(),
    );
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
    ctx?.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      data: [...(ctx?.getImageData(0, 0, bitmap.width, bitmap.height).data ?? [])],
    };
  }, png);
  const [renderLeft, renderRight] = inkColumns(image, b.y, b.y + b.height);
  // Each glyph fills most of its em, so the ink spans the bounds as render's does.
  expect(renderLeft).toBeGreaterThanOrEqual(b.x - 1);
  expect(renderRight).toBeLessThanOrEqual(b.x + b.width + 1);
  expect(renderRight - renderLeft).toBeGreaterThan(b.width - 12);
  await expect
    .poll(async () => {
      const c = await canvas();
      const [left, right] = inkColumns(c, b.y, b.y + b.height, c.k);
      return [left - renderLeft, right - renderRight].map((d) => (Math.abs(d) <= 1.5 ? "same" : d));
    })
    .toEqual(["same", "same"]);
  // 小's vertical stroke, down the middle of its em, is ink: a .notdef box is hollow there.
  const c = await canvas();
  const at = (x: number, y: number) =>
    c.data[(Math.round(y * c.k) * c.width + Math.round(x * c.k)) * 4];
  expect(at(44, 36)).toBeLessThan(128);
});

test("a Latin-only Document never requests Noto Sans SC", async ({ page, request }) => {
  const requested = noto(page);
  await textDoc(page, request, { content: "Hello" });
  await page.evaluate(() => document.fonts.ready);
  // The Source Sans 3 faces load at once, not after Noto Sans SC.
  await expect
    .poll(() =>
      page.evaluate(async () => (await document.fonts.load('12px "Source Sans 3"')).length),
    )
    .toBe(1);
  expect(requested).toEqual([]);
});
