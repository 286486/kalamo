import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #261: Window > Pathfinder's Shape Modes run the expanded path_op on the selected Nodes, select
// its result, undo in one step, and show the server's refusal (ADR-0104).

interface Entry {
  id: string;
  type: string;
}

/** A red rect "Red" at x 20 behind a blue one "Blue" at `x2`, both 40 × 40 and selected. */
async function setup(page: Page, request: APIRequestContext, x2: number) {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Pathfinder",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const rect = (x: number, color: string, name: string) => ({
    type: "rect",
    parentId,
    name,
    x,
    y: 20,
    width: 40,
    height: 40,
    appearance: { fills: [{ color }] },
  });
  const ids = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [rect(20, "#FF0000", "Red"), rect(x2, "#0000FF", "Blue")],
    })
  ).structuredContent.createdIds as string[];
  /** The Layer's children, bottom first. */
  const art = async () =>
    (
      (await call(request, "kalamo_doc_outline", { docId, depth: 9 })).structuredContent.nodes[0]
        .children ?? []
    ).map((e: Entry) => ({ id: e.id, type: e.type })) as Entry[];
  const fill = async (id: string) =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent.nodes[0].appearance.fills[0].color;
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Shift+Control+F9");
  const panel = page.getByRole("region", { name: "Pathfinder" });
  const modes = panel.getByRole("group", { name: "Shape Modes" }).getByRole("button");
  /** The Layers rows whose name button is pressed: the Selection's, by their labels. */
  const selected = () =>
    page
      .getByRole("listitem")
      .evaluateAll((els) =>
        els.flatMap((e) => (e.querySelector("[aria-pressed=true]") ? [e.ariaLabel] : [])),
      );
  return { ids, art, fill, panel, modes, selected };
}

test("Unite replaces two selected rects with one selected path, and one Ctrl+Z restores them", async ({
  page,
  request,
}) => {
  const { ids, art, modes, panel, selected } = await setup(page, request, 40);
  // Shift+Ctrl+F9 showed the panel, checked under Window; Window > Pathfinder hides it again.
  const item = page.getByRole("menuitemcheckbox", { name: "Pathfinder" });
  await expect(panel).toBeVisible();
  await page.getByRole("menuitem", { name: "Window", exact: true }).click();
  await expect(item).toHaveAttribute("aria-checked", "true");
  await item.click();
  await expect(panel).toBeHidden();
  await page.keyboard.press("Shift+Control+F9");
  await expect(panel).toBeVisible();
  await expect(modes).toHaveText(["Unite", "Minus Front", "Intersect", "Exclude"]);
  await expect(panel.getByRole("button")).toHaveCount(4);
  await expect.poll(selected).toHaveLength(2);

  await panel.getByRole("button", { name: "Unite" }).click();
  await expect.poll(art).toEqual([{ id: expect.any(String), type: "path" }]);
  // The result takes the top operand's name (ADR-0104).
  await expect.poll(selected).toEqual(["Blue"]);
  for (const m of await modes.all()) await expect(m).toBeDisabled();

  await page.keyboard.press("Control+Z");
  await expect.poll(art).toEqual(ids.map((id) => ({ id, type: "rect" })));
});

test("Tab and Enter run Minus Front, whose result keeps the back rect's fill", async ({
  page,
  request,
}) => {
  const { art, fill, panel, selected } = await setup(page, request, 40);
  await panel.getByRole("button", { name: "Unite" }).focus();
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Minus Front" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(art).toEqual([{ id: expect.any(String), type: "path" }]);
  const [result] = await art();
  expect(await fill(result?.id as string)).toBe("#FF0000");
  // Enter pressed the button only, and the result, named for Minus Front's back operand, is selected.
  await expect.poll(selected).toEqual(["Red"]);
});

test("Intersect on disjoint rects shows the server's message and changes nothing", async ({
  page,
  request,
}) => {
  const { ids, art, panel } = await setup(page, request, 120);
  await panel.getByRole("button", { name: "Intersect" }).click();
  await expect(page.getByRole("alert")).toHaveText("The objects have no area in common.");
  expect(await art()).toEqual(ids.map((id) => ({ id, type: "rect" })));
});

test("one selected rect disables every Shape Mode", async ({ page, request }) => {
  const { modes, panel, selected } = await setup(page, request, 120);
  await expect(modes.first()).toBeEnabled();
  // A click on Red's Layers row selects it alone.
  await page.getByRole("button", { name: "Red", exact: true }).click();
  await expect.poll(selected).toEqual(["Red"]);
  for (const m of await modes.all()) await expect(m).toBeDisabled();
  await expect(panel).toBeVisible();
});

test("Space presses a focused Shape Mode rather than reaching the canvas's hand", async ({
  page,
  request,
}) => {
  const { art, panel } = await setup(page, request, 40);
  await panel.getByRole("button", { name: "Exclude" }).focus();
  // Held, Space would show the Hand tool's cursor if it reached the canvas.
  await page.keyboard.down("Space");
  await expect(page.getByTestId("overlay")).not.toHaveCSS("cursor", "grab");
  await page.keyboard.up("Space");
  await expect.poll(art).toEqual([{ id: expect.any(String), type: "path" }]);
});
