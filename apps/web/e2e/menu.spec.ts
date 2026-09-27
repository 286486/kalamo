import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";
import { choose } from "./menubar.ts";

test("menu commands run from the menu bar, by their shortcuts, and with the keyboard only", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId } = (
    await call(request, "zibel_doc_create", {
      name: "Menus",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  await call(request, "zibel_node_create", {
    docId,
    nodes: [
      { type: "rect", parentId: defaultLayerId, name: "Box", x: 0, y: 0, width: 10, height: 10 },
    ],
  });
  await page.goto(`/docs/${docId}`);
  await expect(page.getByRole("status")).toContainText(/\d+%/);
  const box = page.getByRole("button", { name: "Box", exact: true });
  const item = (name: string) => page.getByRole("menuitem", { name, exact: true });

  // The same command from the menu and by its shortcut.
  await choose(page, "Select", "All");
  await expect(box).toHaveAttribute("aria-pressed", "true");
  await expect(item("All")).toBeHidden();
  await page.keyboard.press("Shift+Control+A");
  await expect(box).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Control+A");
  await expect(box).toHaveAttribute("aria-pressed", "true");

  // What does not apply now is greyed out, and does nothing.
  await choose(page, "Select", "Deselect");
  await item("Edit").click();
  await expect(item("Clear")).toHaveAttribute("aria-disabled", "true");
  await expect(item("Undo")).toHaveAttribute("aria-disabled", "false");
  // While a menu is open, pointing at another title switches to it; Escape closes it.
  await item("View").hover();
  await expect(item("Clear")).toBeHidden();
  await expect(item("Actual Size")).toBeVisible();
  await item("Actual Size").click();
  await expect(page.getByRole("status")).toContainText("100%");
  await page.keyboard.press("Control+=");
  await expect(page.getByRole("status")).toContainText("150%");

  // Window > Layers hides the panel, F7 shows it again.
  await choose(page, "Window", "Layers");
  await expect(box).toBeHidden();
  await item("Window").click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Layers" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitemcheckbox", { name: "Layers" })).toBeHidden();
  await page.keyboard.press("F7");
  await expect(box).toBeVisible();

  // The keyboard alone: F10, arrows, typeahead, Enter, Escape.
  await page.keyboard.press("F10");
  await expect(item("File")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item("Open…")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(item("Open…")).toBeHidden();
  await expect(item("File")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(item("Edit")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(item("All")).toBeFocused();
  await page.keyboard.press("i");
  await expect(item("Inverse")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(item("Undo")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(item("All")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(item("All")).toBeHidden();
  await expect(box).toHaveAttribute("aria-pressed", "true");

  // A submenu: File > Export > Export As SVG downloads.
  await page.keyboard.press("F10");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("e");
  await expect(item("Export")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(item("Export As SVG")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(item("Export As SVG")).toBeHidden();
  await expect(item("Export")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.keyboard.press("Enter"),
  ]);
  expect(download.suggestedFilename()).toBe("Menus.svg");
});

test("the Document list's menu bar has File > Open… only", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("menubar").getByRole("menuitem")).toHaveText(["File"]);
  await choose(page, "File");
  await expect(page.getByRole("menu", { name: "File" }).getByRole("menuitem")).toHaveText([
    /^Open…/,
  ]);
});
