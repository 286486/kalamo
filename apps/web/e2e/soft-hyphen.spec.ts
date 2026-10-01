import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #227: a soft hyphen draws nothing and takes no width on the canvas, in a line and at a break,
// tracked or not, and as a text Clipping Path's glyphs, which hit-test as drawn (ADR-0094).
test("the canvas draws a soft hyphen as nothing, and a click past one hits its text", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Soft hyphen",
      artboards: [{ width: 200, height: 200 }],
    })
  ).structuredContent;
  const SHY = "\u00AD";
  // Each pair is a row 50 pt tall: the text with soft hyphens on the left, without on the right.
  const pairs = [
    [{ content: `ab${SHY}cd` }, { content: "abcd" }],
    [
      { content: `ab${SHY}cd`, tracking: 300, name: "Tracked" },
      { content: "abcd", tracking: 300 },
    ],
    [
      { kind: "area", width: 40, height: 40, content: `xx x${SHY}yyy` },
      { kind: "area", width: 40, height: 40, content: "xx x yyy" },
    ],
  ];
  const nodes = pairs.flatMap((pair, row) =>
    pair.map((t, side) => ({
      type: "text",
      parentId,
      fontSize: 16,
      ...t,
      x: 10 + side * 100,
      y: "kind" in t ? row * 50 + 5 : row * 50 + 30,
    })),
  );
  // A text Clipping Path over a black square, as the fourth row.
  const square = { type: "rect", parentId, width: 100, height: 50, y: 150 };
  for (const [side, content] of [`ab${SHY}cd`, "abcd"].entries()) {
    const { createdIds } = (
      await call(request, "kalamo_node_create", {
        docId,
        nodes: [
          { ...square, x: side * 100, appearance: { fills: [{ color: "#000000" }] } },
          { type: "text", parentId, x: 10 + side * 100, y: 185, fontSize: 30, content },
        ],
      })
    ).structuredContent;
    await call(request, "kalamo_mask_make", {
      docId,
      clipNodeId: createdIds[1],
      contentIds: [createdIds[0]],
    });
  }
  await call(request, "kalamo_node_create", { docId, nodes });
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  await page.evaluate(() => document.fonts.ready);

  /** Each row's left and right halves of the Artboard's pixels, 2 pt in from its edges, which should match. */
  const halves = () =>
    page.getByTestId("canvas").evaluate((el: HTMLCanvasElement) => {
      const k = el.width / el.getBoundingClientRect().width;
      const [x, y] = [el.width / 2 - 100 * k, el.height / 2 - 100 * k];
      const ctx = el.getContext("2d");
      const half = (dx: number, row: number) =>
        ctx?.getImageData(x + (dx + 2) * k, y + (row * 50 + 2) * k, 96 * k, 46 * k).data.join() ??
        "";
      return [0, 1, 2, 3].map((row) => [half(0, row), half(100, row)]);
    });
  await expect.poll(async () => (await halves()).every(([a, b]) => a === b)).toBe(true);
  // Each row draws something.
  for (const [a] of await halves()) expect(a).toMatch(/(^|,)0,0,0,255/);

  // A click on the ink of `d`, past the soft hyphen, hits the tracked text, and inside a text
  // Clipping Path's `d` hits what it clips (ADR-0052).
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  /** The rightmost inked column in pt of a row's left half, `y` pt into the row. */
  const lastInk = (row: number, y: number) =>
    page.getByTestId("canvas").evaluate(
      (el: HTMLCanvasElement, { row, y }) => {
        const k = el.width / el.getBoundingClientRect().width;
        const [x0, y0] = [el.width / 2 - 100 * k, el.height / 2 - 100 * k];
        const data = el.getContext("2d")?.getImageData(x0, y0 + (row * 50 + y) * k, 96 * k, 1).data;
        let last = -1;
        for (let i = 0; i < (data?.length ?? 0); i += 4) if ((data?.[i] ?? 255) < 64) last = i / 4;
        return last / k;
      },
      { row, y },
    );
  const click = async (row: number, y: number) => {
    const x = (await lastInk(row, y)) - 1;
    await page.mouse.click(
      box.x + box.width / 2 - 100 + x,
      box.y + box.height / 2 - 100 + row * 50 + y,
    );
  };
  const pressed = page.locator('[aria-pressed="true"]');
  await click(1, 25);
  await expect(page.getByRole("button", { name: "Tracked", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.mouse.click(box.x + 5, box.y + 5);
  await click(3, 25);
  await expect(pressed.filter({ hasText: "<Clip Group>" })).toHaveCount(1);
});
