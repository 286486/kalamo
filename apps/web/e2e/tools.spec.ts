import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #142: the Pen and Rectangle groups each show one button, with a flyout of the group's tools.
test("a group's flyout opens by hold, right-click or keyboard, and fronts the chosen tool", async ({
  page,
  request,
}) => {
  const { docId } = (
    await call(request, "zibel_doc_create", {
      name: "Tools",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  const tools = page.getByRole("toolbar", { name: "Tools" });
  const tool = (name: string) => tools.getByRole("button", { name, exact: true });
  const menu = tools.getByRole("menu");
  const item = (name: string) => menu.getByRole("menuitemradio", { name, exact: true });

  // One button per group: the lone tools, Pen's five in one, Rectangle and Ellipse in one.
  await expect(tools.getByRole("button", { name: /Tool \(/ })).toHaveCount(6);
  await expect(tool("Curvature Tool (Shift+~)")).toHaveCount(0);

  // Holding the Pen opens its flyout, each tool with its title and shortcut; a click picks one.
  const pen = tool("Pen Tool (P)");
  const box = await pen.boundingBox();
  if (!box) throw new Error("no Pen button");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(menu).toBeVisible();
  await page.mouse.up();
  await expect(menu.getByRole("menuitemradio")).toHaveText([
    "Pen ToolP",
    "Add Anchor Point Tool+",
    "Delete Anchor Point Tool-",
    "Anchor Point ToolShift+C",
    "Curvature ToolShift+~",
  ]);
  await expect(item("Pen Tool (P)")).toHaveAttribute("aria-checked", "true");
  // The hold's release chose nothing.
  await expect(tool("Selection Tool (V)")).toHaveAttribute("aria-pressed", "true");
  await item("Curvature Tool (Shift+~)").click();
  await expect(menu).toHaveCount(0);
  await expect(tool("Curvature Tool (Shift+~)")).toHaveAttribute("aria-pressed", "true");
  await expect(pen).toHaveCount(0);

  // A click on the group's button picks its shown tool; P fronts the Pen again.
  await tool("Selection Tool (V)").click();
  await tool("Curvature Tool (Shift+~)").click();
  await expect(tool("Curvature Tool (Shift+~)")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("p");
  await expect(pen).toHaveAttribute("aria-pressed", "true");

  // M and L switch the Rectangle group's button; a right-click opens its flyout, a click outside closes it.
  await page.keyboard.press("l");
  await expect(tool("Ellipse Tool (L)")).toHaveAttribute("aria-pressed", "true");
  await expect(tool("Rectangle Tool (M)")).toHaveCount(0);
  await tool("Ellipse Tool (L)").click({ button: "right" });
  await expect(menu.getByRole("menuitemradio")).toHaveText([
    "Rectangle ToolM",
    "Rounded Rectangle Tool",
    "Ellipse ToolL",
    "Polygon Tool",
  ]);
  await page.getByTestId("overlay").click({ position: { x: 600, y: 600 } });
  await expect(menu).toHaveCount(0);
  await expect(tool("Ellipse Tool (L)")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("m");
  await expect(tool("Rectangle Tool (M)")).toHaveAttribute("aria-pressed", "true");

  // The keyboard: Enter opens, arrows move, Enter picks, Esc closes, focus back on the button.
  await pen.focus();
  await page.keyboard.press("Enter");
  await expect(item("Pen Tool (P)")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(item("Curvature Tool (Shift+~)")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(item("Add Anchor Point Tool (+)")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  const add = tool("Add Anchor Point Tool (+)");
  await expect(add).toHaveAttribute("aria-pressed", "true");
  await expect(add).toBeFocused();
  await page.keyboard.press(" ");
  await expect(item("Add Anchor Point Tool (+)")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await expect(tool("Delete Anchor Point Tool (-)")).toHaveAttribute("aria-pressed", "true");
  const del = tool("Delete Anchor Point Tool (-)");
  await expect(del).toBeFocused();
  // A tool's shortcut leaves the flyout.
  await page.keyboard.press("Enter");
  await page.keyboard.press("m");
  await expect(menu).toHaveCount(0);
  await expect(tool("Rectangle Tool (M)")).toHaveAttribute("aria-pressed", "true");
  await del.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(del).toBeFocused();
  await expect(tool("Rectangle Tool (M)")).toHaveAttribute("aria-pressed", "true");
});
