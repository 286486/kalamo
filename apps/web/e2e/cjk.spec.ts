import { expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

/** A Noto family's files, which only a Document that draws in it may request (ADR-0063, ADR-0066). */
const noto = (page: Page, file = "NotoSansSC") => {
  const urls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes(file)) urls.push(r.url());
  });
  return urls;
};

/** The weight, style and status of each face `family` registered, sorted. */
const faces = (page: Page, family: string) =>
  page.evaluate(
    (family) =>
      [...document.fonts]
        .filter((f) => f.family.replace(/"/g, "") === family)
        .map((f) => `${f.weight} ${f.style} ${f.status}`)
        .sort(),
    family,
  );
const LOADED = ["400", "700"].flatMap((w) => [`${w} italic loaded`, `${w} normal loaded`]);

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

/** The Artboard's canvas pixels at `k` px per pt; its centre, (100, 50), is the canvas's at 100%. */
const canvas = (page: Page) =>
  page.getByTestId("canvas").evaluate((el: HTMLCanvasElement) => {
    const k = el.width / el.getBoundingClientRect().width;
    const [x, y] = [el.width / 2 - 100 * k, el.height / 2 - 50 * k];
    const pixels = el.getContext("2d")?.getImageData(x, y, 200 * k, 100 * k);
    return { k, width: pixels?.width ?? 0, data: [...(pixels?.data ?? [])] };
  });

/** The Artboard as `zibel_render` draws it at 1 px per pt, decoded in the page, whose canvas reads a PNG. */
async function rendered(page: Page, request: Parameters<typeof call>[0], docId: string) {
  const result = await call(request, "zibel_render", {
    docId,
    scope: { rect: { x: 0, y: 0, width: 200, height: 100 } },
    scale: 1,
    background: "#FFFFFF",
  });
  const png = result.content.find((c: { type: string }) => c.type === "image").data as string;
  return page.evaluate(async (png) => {
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
}

// #159: CJK draws in Noto Sans SC, loaded lazily, measured as `render` draws it (ADR-0063).
test("a CJK text loads Noto Sans SC and draws its glyphs inside the bounds render draws", async ({
  page,
  request,
}) => {
  const [requested, korean] = [noto(page), noto(page, "NotoSansKR")];
  const { docId, id } = await textDoc(page, request, {
    content: "小动物",
    fontStyle: "Bold Italic",
  });
  await expect.poll(() => faces(page, "Noto Sans SC")).toEqual(LOADED);
  expect(requested).toHaveLength(2);
  await page.evaluate(() => document.fonts.ready);
  expect(korean).toEqual([]);

  const b = (await call(request, "zibel_node_get", { docId, nodeIds: [id] })).structuredContent
    .nodes[0].geometricBounds;
  expect(b.width).toBeCloseTo(3 * 48);
  const image = await rendered(page, request, docId);
  const [renderLeft, renderRight] = inkColumns(image, b.y, b.y + b.height);
  // Each glyph fills most of its em, so the ink spans the bounds as render's does.
  expect(renderLeft).toBeGreaterThanOrEqual(b.x - 1);
  expect(renderRight).toBeLessThanOrEqual(b.x + b.width + 1);
  expect(renderRight - renderLeft).toBeGreaterThan(b.width - 12);
  await expect
    .poll(async () => {
      const c = await canvas(page);
      const [left, right] = inkColumns(c, b.y, b.y + b.height, c.k);
      return [left - renderLeft, right - renderRight].map((d) => (Math.abs(d) <= 1.5 ? "same" : d));
    })
    .toEqual(["same", "same"]);
  // 小's vertical stroke, down the middle of its em, is ink: a .notdef box is hollow there.
  const c = await canvas(page);
  const at = (x: number, y: number) =>
    c.data[(Math.round(y * c.k) * c.width + Math.round(x * c.k)) * 4];
  expect(at(44, 36)).toBeLessThan(128);
});

// #164: Hangul draws in Noto Sans KR, loaded lazily on its own, measured as `render` draws it (ADR-0066).
test("a Korean text loads Noto Sans KR alone and draws its glyphs inside the bounds render draws", async ({
  page,
  request,
}) => {
  const [korean, chinese] = [noto(page, "NotoSansKR"), noto(page)];
  const { docId, id } = await textDoc(page, request, { content: "한국어", fontStyle: "Bold" });
  await expect.poll(() => faces(page, "Noto Sans KR")).toEqual(LOADED);
  expect(korean).toHaveLength(2);
  expect(chinese).toEqual([]);

  const b = (await call(request, "zibel_node_get", { docId, nodeIds: [id] })).structuredContent
    .nodes[0].geometricBounds;
  expect(b.width).toBeCloseTo(3 * 0.92 * 48);
  const image = await rendered(page, request, docId);
  const [renderLeft, renderRight] = inkColumns(image, b.y, b.y + b.height);
  expect(renderLeft).toBeGreaterThanOrEqual(b.x - 1);
  expect(renderRight).toBeLessThanOrEqual(b.x + b.width + 1);
  expect(renderRight - renderLeft).toBeGreaterThan(b.width - 12);
  await expect
    .poll(async () => {
      const c = await canvas(page);
      const [left, right] = inkColumns(c, b.y, b.y + b.height, c.k);
      return [left - renderLeft, right - renderRight].map((d) => (Math.abs(d) <= 1.5 ? "same" : d));
    })
    .toEqual(["same", "same"]);
});

test("a Latin-only Document requests neither Noto family", async ({ page, request }) => {
  const requested = [...noto(page), ...noto(page, "NotoSansKR")];
  await textDoc(page, request, { content: "Hello" });
  await page.evaluate(() => document.fonts.ready);
  // The Source Sans 3 faces load at once, not after a Noto family.
  await expect
    .poll(() =>
      page.evaluate(async () => (await document.fonts.load('12px "Source Sans 3"')).length),
    )
    .toBe(1);
  expect(requested).toEqual([]);
});

// #165: a character no bundled face has draws as render's .notdef box, never in a system font
// (ADR-0065). Playwright's `--with-deps` installs Noto Color Emoji on CI, so the browser there
// has an emoji to fall back to; without a system font that has one, the test still checks that no
// fillText or strokeText asks for it and that the canvas draws what render draws, and says so.
test("an emoji draws as render's .notdef box inside the bounds, not as a system glyph", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const asked: string[] = [];
    Object.assign(window, { asked });
    const proto = CanvasRenderingContext2D.prototype;
    for (const k of ["fillText", "strokeText"] as const) {
      const f = proto[k];
      proto[k] = function (this: CanvasRenderingContext2D, t: string, x: number, y: number) {
        asked.push(t);
        return f.call(this, t, x, y);
      };
    }
  });
  const { docId, id } = await textDoc(page, request, { content: "A😀B" });
  const coloured = ({ data }: { data: ArrayLike<number> }) => {
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 64) n++;
    }
    return n;
  };
  // Whether a system font has 😀: the browser then draws it unlike a code point no font has.
  const system = await page.evaluate(() => {
    const draw = (t: string) => {
      const ctx = new OffscreenCanvas(64, 64).getContext("2d");
      if (!ctx) return "";
      ctx.font = "48px sans-serif";
      ctx.fillText(t, 0, 50);
      return ctx.getImageData(0, 0, 64, 64).data.join();
    };
    return draw("😀") !== draw("\u{10FFFD}");
  });
  test.info().annotations.push({
    type: "system emoji glyph",
    description: system
      ? "present: the canvas would draw 😀 in a system font if it asked for it"
      : "absent: only checks that no fillText or strokeText asks for 😀 and the canvas matches render",
  });

  const b = (await call(request, "zibel_node_get", { docId, nodeIds: [id] })).structuredContent
    .nodes[0].geometricBounds;
  const image = await rendered(page, request, docId);
  const [renderLeft, renderRight] = inkColumns(image, b.y, b.y + b.height);
  expect(renderLeft).toBeGreaterThanOrEqual(b.x - 1);
  expect(renderRight).toBeLessThanOrEqual(b.x + b.width + 1);
  await expect
    .poll(async () => {
      const c = await canvas(page);
      const [left, right] = inkColumns(c, b.y, b.y + b.height, c.k);
      return [left - renderLeft, right - renderRight].map((d) => (Math.abs(d) <= 1.5 ? "same" : d));
    })
    .toEqual(["same", "same"]);
  const c = await canvas(page);
  expect(coloured(c)).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as { asked: string[] }).asked),
  ).not.toContainEqual(expect.stringContaining("😀"));
  // The box's cell, from A's advance (Source Sans 3 Regular's 544 units) for .notdef's 653, holds
  // about as much ink as render's box.
  const dark = (p: { width: number; data: ArrayLike<number> }, k: number) => {
    let n = 0;
    for (let y = Math.round(b.y * k); y < Math.round((b.y + b.height) * k); y++) {
      for (
        let x = Math.round((b.x + 0.544 * 48) * k);
        x < Math.round((b.x + 1.197 * 48) * k);
        x++
      ) {
        if ((p.data[(y * p.width + x) * 4] ?? 255) < 128) n++;
      }
    }
    return n / (k * k);
  };
  expect(dark(image, 1)).toBeGreaterThan(200);
  expect(dark(c, c.k) / dark(image, 1)).toBeCloseTo(1, 1);
});
