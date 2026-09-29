import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";

test.use({ hasTouch: true });

// #132: a touch double-tap counts its own taps, where a tap's mousedown comes too late (ADR-0057).
test("A touch double-tap enters and leaves Isolation Mode as a mouse double-click does", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: layer } = (
    await call(request, "kalamo_doc_create", {
      name: "Isolation touch",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  // G holds H, which holds Red (20–180 × 20–80); below it the Artboard is empty.
  await call(request, "kalamo_node_create", {
    docId,
    nodes: [
      {
        type: "group",
        parentId: layer,
        name: "G",
        children: [
          {
            type: "group",
            name: "H",
            children: [
              {
                type: "rect",
                name: "Red",
                x: 20,
                y: 20,
                width: 160,
                height: 60,
                appearance: { fills: [{ color: "#FF0000" }], strokes: [] },
              },
            ],
          },
        ],
      },
    ],
  });
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;
  const bar = page.getByRole("navigation", { name: "Isolation Mode" });
  const level = bar.locator("[aria-current=location]");
  const row = (name: string) => page.getByRole("button", { name, exact: true });
  const taps = async (...points: (readonly [number, number])[]) => {
    await page.waitForTimeout(600);
    for (const [i, p] of points.entries()) {
      if (i > 0) await page.waitForTimeout(80);
      await page.touchscreen.tap(...at(...p));
    }
  };

  // Two taps too far apart in time, then in space, stay two single taps.
  await page.touchscreen.tap(...at(40, 50));
  await page.waitForTimeout(700);
  await page.touchscreen.tap(...at(40, 50));
  await taps([40, 50], [100, 50]);
  await expect(row("G")).toHaveAttribute("aria-pressed", "true");
  await expect(bar).toBeHidden();

  // A double-tap isolates G and selects what is under the tap, then goes one level deeper.
  await taps([40, 50], [40, 50]);
  await expect(level).toContainText("G");
  await expect(row("H")).toHaveAttribute("aria-pressed", "true");
  await taps([40, 50], [40, 50]);
  await expect(level).toContainText("H");
  await expect(row("Red")).toHaveAttribute("aria-pressed", "true");

  // A double-tap on nothing goes up one level.
  await taps([100, 92], [100, 92]);
  await expect(level).toContainText("G");

  // A tap and then a mouse click are not a double-click; a mouse double-click still is.
  await taps([40, 50]);
  await page.waitForTimeout(80);
  await page.mouse.click(...at(40, 50));
  await expect(row("H")).toHaveAttribute("aria-pressed", "true");
  await expect(level).toContainText("G");
  await page.waitForTimeout(600);
  await page.mouse.dblclick(...at(40, 50));
  await expect(level).toContainText("H");
});
