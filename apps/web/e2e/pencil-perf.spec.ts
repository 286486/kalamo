import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #83, F-FREE-02 and REQUIREMENTS §7.1: a Pencil pointer move shows its preview within a frame
// (16 ms) on the target laptops, on a Document of 5,000 paths, the Canvas2D phase's target. The
// check asserts 4 ms: redrawing the whole Document per move measured 10 ms median and 18 ms at
// worst on a fast desktop, while drawing only the move's piece of Ink took 0.1 ms.
test("a Pencil move draws its preview in well under a frame on 5,000 paths", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId } = (
    await call(request, "zibel_doc_create", {
      name: "Pencil perf",
      artboards: [{ width: 800, height: 600 }],
    })
  ).structuredContent;
  // Deterministic curves across the Artboard, 1,000 per call.
  for (let batch = 0; batch < 5; batch++) {
    const nodes = Array.from({ length: 1000 }, (_, k) => {
      const i = batch * 1000 + k;
      const [x, y] = [(i * 37) % 760, (i * 53) % 560];
      return {
        type: "path",
        parentId: defaultLayerId,
        d: `M ${x} ${y} C ${x + 10} ${y - 20} ${x + 30} ${y + 20} ${x + 40} ${y}`,
        appearance: { fills: [], strokes: [{ color: "#336699", width: 1 }] },
      };
    });
    await call(request, "zibel_node_create", { docId, nodes });
  }
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  await page.keyboard.press("n");
  // When each move reached the page, and when a canvas last finished a stroke: the Pencil's
  // preview is the last thing drawn for a move.
  await page.evaluate(() => {
    const w = window as unknown as { moved: number; drawn: number };
    w.moved = w.drawn = 0;
    addEventListener("pointermove", () => (w.moved = performance.now()), { capture: true });
    const stroke = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (this: CanvasRenderingContext2D, ...a) {
      stroke.apply(this, a as never);
      w.drawn = performance.now();
    } as typeof stroke;
  });
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(cx - 200, cy);
  await page.mouse.down();
  const times: number[] = [];
  for (let i = 1; i <= 60; i++) {
    await page.mouse.move(cx - 200 + i * 6, cy + 40 * Math.sin(i / 6));
    // Long enough for any frame the move started to finish.
    await page.waitForTimeout(40);
    times.push(
      await page.evaluate(() => {
        const w = window as unknown as { moved: number; drawn: number };
        return w.drawn - w.moved;
      }),
    );
  }
  await page.mouse.up();
  const sorted = times.slice(10).sort((a, b) => a - b);
  const [median, p95] = [
    sorted[Math.floor(sorted.length / 2)],
    sorted[Math.floor(sorted.length * 0.95)],
  ];
  console.log(
    `pencil preview ms: median ${median?.toFixed(2)} p95 ${p95?.toFixed(2)} max ${sorted.at(-1)?.toFixed(2)}`,
  );
  expect(p95).toBeLessThan(4);
});
