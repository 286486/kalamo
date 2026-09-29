import { expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #83, #94, F-FREE-02 and REQUIREMENTS §7.1: a tool's preview follows a pointer move within a frame
// (16 ms) on the target laptops, on a Document of 5,000 paths, the Canvas2D phase's target. The
// tools draw on the overlay canvas, so a move repaints none of the Document's Nodes: repainting
// them all per move measured 10 ms median and 18 ms at worst on a fast desktop.
test.beforeEach(async ({ page, request }) => {
  const { docId, defaultLayerId } = (
    await call(request, "kalamo_doc_create", {
      name: "Overlay perf",
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
    await call(request, "kalamo_node_create", { docId, nodes });
  }
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
});

/** Moves the pointer 60 times; returns each move's time to the last stroke drawn, in ms. */
async function measureMoves(page: Page, cx: number, cy: number) {
  // When each move reached the page, when a canvas last finished a stroke, and how many strokes
  // the Document's canvas drew: a tool's preview is the last thing drawn for a move.
  await page.evaluate(() => {
    const w = window as unknown as { moved: number; drawn: number; repainted: number };
    w.moved = w.drawn = w.repainted = 0;
    addEventListener("pointermove", () => (w.moved = performance.now()), { capture: true });
    const stroke = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (this: CanvasRenderingContext2D, ...a) {
      stroke.apply(this, a as never);
      w.drawn = performance.now();
      if (this.canvas.dataset.testid === "canvas") w.repainted++;
    } as typeof stroke;
  });
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
  const repainted = await page.evaluate(
    () => (window as unknown as { repainted: number }).repainted,
  );
  expect(repainted).toBe(0);
  // A move that drew nothing would read as fast.
  expect(Math.min(...times)).toBeGreaterThan(0);
  return times;
}

function expectWithinFrame(name: string, times: number[]) {
  const sorted = times.slice(10).sort((a, b) => a - b);
  const [median, p95] = [
    sorted[Math.floor(sorted.length / 2)],
    sorted[Math.floor(sorted.length * 0.95)],
  ];
  console.log(
    `${name} preview ms: median ${median?.toFixed(2)} p95 ${p95?.toFixed(2)} max ${sorted.at(-1)?.toFixed(2)}`,
  );
  expect(p95).toBeLessThan(16);
}

async function centre(page: Page) {
  const box = await page.getByTestId("overlay").boundingBox();
  if (!box) throw new Error("no canvas");
  return [box.x + box.width / 2, box.y + box.height / 2] as const;
}

test("a Pencil move draws its Ink in under a frame on 5,000 paths", async ({ page }) => {
  await page.keyboard.press("n");
  const [cx, cy] = await centre(page);
  await page.mouse.move(cx - 200, cy);
  await page.mouse.down();
  const times = await measureMoves(page, cx, cy);
  await page.mouse.up();
  expectWithinFrame("pencil", times);
});

test("a Pen rubber band follows a move in under a frame on 5,000 paths", async ({ page }) => {
  await page.keyboard.press("p");
  const [cx, cy] = await centre(page);
  await page.mouse.click(cx - 200, cy);
  const times = await measureMoves(page, cx, cy);
  await page.keyboard.press("Escape");
  expectWithinFrame("pen", times);
});
