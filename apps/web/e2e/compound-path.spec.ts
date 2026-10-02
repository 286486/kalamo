import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";
import { choose } from "./menubar.ts";

// #266: Object > Compound Path > Make cuts a hole where the objects overlap, with the backmost's
// paint, and Release splits it back into paths; each is one undo step (ADR-0107).

test("Ctrl+8 makes a ring from two squares, Release splits it, and Ctrl+Z undoes each", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Compound Path",
      artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
    })
  ).structuredContent;
  const square = (name: string, x: number, y: number, size: number, color: string) => ({
    ...{ type: "rect", parentId, name, x, y, width: size, height: size },
    appearance: { fills: [{ color }] },
  });
  await call(request, "kalamo_node_create", {
    docId,
    nodes: [square("Outer", 60, 10, 80, "#FF0000"), square("Inner", 90, 40, 20, "#0000FF")],
  });
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const row = (name: string) => page.getByRole("button", { name, exact: true });
  const item = (name: string) => page.getByRole("menuitem", { name, exact: true });

  // At 100% the Artboard's centre, (100, 50), is the canvas's: the hole, then the ring at x 70.
  const colors = () =>
    page.getByTestId("canvas").evaluate((el: HTMLCanvasElement) => {
      const k = el.width / el.getBoundingClientRect().width;
      const ctx = el.getContext("2d");
      return [100, 70].map((x) => {
        const [px, py] = [(el.width / k / 2 + x - 100) * k, (el.height / k / 2) * k];
        const [r = 0, g = 0, b = 0] = ctx?.getImageData(px, py, 1, 1).data ?? [];
        return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
      });
    });
  await expect.poll(colors).toEqual(["#0000FF", "#FF0000"]);

  // One square selected: neither applies.
  await row("Outer").click();
  await choose(page, "Object", "Compound Path");
  await expect(item("Make")).toHaveAttribute("aria-disabled", "true");
  await expect(item("Release")).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+8");
  await expect(row("<Compound Path>")).toHaveAttribute("aria-pressed", "true");
  await expect(row("Outer")).toBeHidden();
  await expect.poll(colors).toEqual(["#FFFFFF", "#FF0000"]);

  await choose(page, "Object", "Compound Path", "Release");
  await expect(row("<Compound Path>")).toBeHidden();
  await expect(row("<Path>")).toHaveCount(2);
  await expect.poll(colors).toEqual(["#FF0000", "#FF0000"]);

  await page.keyboard.press("Control+Z");
  await expect(row("<Compound Path>")).toBeVisible();
  await expect.poll(colors).toEqual(["#FFFFFF", "#FF0000"]);
  await page.keyboard.press("Control+Z");
  await expect(row("Outer")).toBeVisible();
  await expect.poll(colors).toEqual(["#0000FF", "#FF0000"]);

  // Release by its shortcut, after Make from the menu.
  await page.keyboard.press("Control+A");
  await choose(page, "Object", "Compound Path", "Make");
  await expect(row("<Compound Path>")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Alt+Shift+Control+8");
  await expect(row("<Path>")).toHaveCount(2);
});
