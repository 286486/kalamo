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
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
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
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  await page.keyboard.press("Control+=");
  await expect(page.getByTestId("status-bar")).toContainText("150%");

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
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(item("All")).toBeFocused();
  await page.keyboard.press("i");
  await expect(item("Inverse")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(item("Path")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(item("Object")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
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

test("Ctrl+7 clips the selection with its topmost Node, and Alt+Ctrl+7 releases it", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId } = (
    await call(request, "zibel_doc_create", {
      name: "Mask",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const rect = (name: string) => ({
    type: "rect",
    parentId: defaultLayerId,
    name,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  });
  await call(request, "zibel_node_create", { docId, nodes: [rect("Art"), rect("Clip")] });
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  const row = (name: string) => page.getByRole("button", { name, exact: true });

  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+7");
  await expect(row("<Clip Group>")).toHaveAttribute("aria-pressed", "true");
  await expect(row("Art")).toBeHidden();

  await page.keyboard.press("Alt+Control+7");
  await expect(row("<Clip Group>")).toBeHidden();
  await expect(row("<Group>")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+Z");
  await expect(row("<Clip Group>")).toBeVisible();
  await choose(page, "Object", "Clipping Mask", "Release");
  await expect(row("<Clip Group>")).toBeHidden();
  await expect(row("<Group>")).toHaveAttribute("aria-pressed", "true");
});

test("Ctrl+7 clips with a text on top: the content shows only through its glyphs (ADR-0052)", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "zibel_doc_create", {
      name: "Type mask",
      artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
    })
  ).structuredContent;
  await call(request, "zibel_node_create", {
    docId,
    nodes: [
      {
        type: "rect",
        parentId,
        name: "Art",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        appearance: { fills: [{ color: "#FF0000" }] },
      },
      // An I in Black at 60 pt: its stem spans about x 24 to 34, y 31 to 70.
      { type: "text", parentId, x: 20, y: 70, content: "I", fontSize: 60, fontStyle: "Black" },
    ],
  });
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const row = (name: string) => page.getByRole("button", { name, exact: true });

  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+7");
  await expect(row("<Clip Group>")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Expand <Clip Group>" }).click();
  await expect(row("<Clipping Path>")).toBeVisible();
  await expect(row("Art")).toBeVisible();

  // At 100% the Artboard's centre, (100, 50), is the canvas's.
  const red = () =>
    page.getByTestId("canvas").evaluate((el: HTMLCanvasElement) => {
      const k = el.width / el.getBoundingClientRect().width;
      const ctx = el.getContext("2d");
      return [29, 15, 150].map((x) => {
        const [px, py] = [(el.width / k / 2 + x - 100) * k, (el.height / k / 2 + 50 - 50) * k];
        const [r, g] = ctx?.getImageData(px, py, 1, 1).data ?? [];
        return r === 255 && g === 0;
      });
    });
  await expect.poll(red).toEqual([true, false, false]);

  await page.keyboard.press("Alt+Control+7");
  await expect(row("<Clip Group>")).toBeHidden();
  await expect.poll(red).toEqual([true, true, true]);
});
