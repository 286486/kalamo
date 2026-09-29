import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

interface Entry {
  id: string;
  name: string;
  type: string;
  children?: Entry[];
}

/**
 * Layer A: Group G (Blue, 35–65), Path P (red, 0–30), sub-Layer S holding sub-Layer T. Layer B, on
 * top: Group H (Green, 70–100). On a 200 × 100 Artboard at 100%. `viewer` opens it as a viewer.
 */
async function setup(page: Page, request: APIRequestContext, { viewer = false } = {}) {
  const { docId, defaultLayerId: a } = (
    await call(request, "kalamo_doc_create", {
      name: "Duplicate Layer",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const rect = (name: string, x: number, color: string) => ({
    type: "rect",
    name,
    x,
    y: 0,
    width: 30,
    height: 100,
    appearance: { fills: [{ color }] },
  });
  await call(request, "kalamo_node_update", {
    docId,
    updates: [{ nodeId: a, patch: { name: "A" } }],
  });
  const { keyMap } = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [
        { type: "group", name: "G", parentId: a, children: [rect("Blue", 35, "#0000FF")] },
        {
          type: "path",
          name: "P",
          parentId: a,
          d: "M 0 0 L 30 0 L 30 100 L 0 100 Z",
          appearance: { fills: [{ color: "#FF0000" }] },
        },
        { type: "layer", name: "S", parentId: a, clientKey: "S" },
        { type: "layer", name: "B", clientKey: "B" },
      ],
    })
  ).structuredContent;
  await call(request, "kalamo_node_create", {
    docId,
    nodes: [
      { type: "layer", name: "T", parentId: keyMap.S },
      { type: "group", name: "H", parentId: keyMap.B, children: [rect("Green", 70, "#00FF00")] },
    ],
  });
  const outline = async () =>
    (await call(request, "kalamo_doc_outline", { docId, depth: 9 })).structuredContent as {
      nodes: Entry[];
      rev: number;
    };
  /** Every Node by name, a list since copies share names. */
  const byName = async () => {
    const out = new Map<string, Entry[]>();
    const walk = (es: Entry[]) => {
      for (const e of es) {
        out.set(e.name, [...(out.get(e.name) ?? []), e]);
        walk(e.children ?? []);
      }
    };
    walk((await outline()).nodes);
    return out;
  };
  const id = async (name: string) => (await byName()).get(name)?.[0]?.id as string;
  /** The names of the children of `name` (or the top-level Layers), bottom first. */
  const children = async (name: string | null) => {
    const find = (es: Entry[]): Entry[] | undefined =>
      name === null
        ? es
        : es.reduce<Entry[] | undefined>(
            (hit, e) => hit ?? (e.name === name ? (e.children ?? []) : find(e.children ?? [])),
            undefined,
          );
    return (find((await outline()).nodes) ?? []).map((e) => e.name);
  };
  const rev = async () => (await outline()).rev;

  const sent: string[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      sent.push(String(m));
      server.send(m);
    });
    server.onMessage((m) => {
      const msg = JSON.parse(String(m));
      ws.send(viewer && msg.type === "document" ? JSON.stringify({ ...msg, role: "viewer" }) : m);
    });
  });
  const duplicates = () =>
    sent.filter((m) => JSON.parse(m).command?.type === "duplicate").map((m) => JSON.parse(m));

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  // The colour on top at x 15 (P), 50 (Blue) and 85 (Green).
  const top = () =>
    page.getByTestId("canvas").evaluate((el: HTMLCanvasElement) => {
      const k = el.width / el.getBoundingClientRect().width;
      const ctx = el.getContext("2d");
      return [15, 50, 85]
        .map((x) => {
          const [px, py] = [(el.width / k / 2 + x - 100) * k, (el.height / k / 2) * k];
          const [r = 0, g = 0, b = 0] = ctx?.getImageData(px, py, 1, 1).data ?? [];
          return r > 200 && g < 50 ? "R" : g > 200 && r < 50 ? "G" : b > 200 && r < 50 ? "B" : "?";
        })
        .join("");
    });
  await expect.poll(top).toBe("RBG");
  const row = (name: string) => page.getByRole("listitem", { name, exact: true });
  const rowNames = () =>
    page.getByRole("listitem").evaluateAll((els) => els.map((e) => e.ariaLabel));
  const pick = (name: string, modifiers?: "Shift"[]) =>
    row(name).getByRole("button", { name, exact: true }).click({ modifiers });
  const menu = page.getByRole("button", { name: "Layers panel menu" });
  const item = page.getByRole("menu", { name: "Layers panel menu" }).getByRole("menuitem");
  /** The positions of the highlighted rows: selected Nodes and Layer rows. */
  const selected = () =>
    page
      .getByRole("listitem")
      .evaluateAll((els) =>
        els.flatMap((e, i) => (e.querySelector("[aria-pressed=true]") ? [i] : [])),
      );
  const duplicate = async () => {
    await menu.click();
    await item.click();
  };
  return {
    docId,
    id,
    byName,
    children,
    rev,
    duplicates,
    top,
    row,
    rowNames,
    pick,
    selected,
    menu,
    item,
    duplicate,
  };
}

test('Duplicate "A" puts "A copy" directly above A, selected, and one Ctrl+Z removes it (#195)', async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  const rev = await s.rev();
  await s.pick("A");
  await s.menu.click();
  await expect(s.item).toHaveText('Duplicate "A"');
  await s.item.click();

  await expect
    .poll(s.rowNames)
    .toEqual(["B", "H", "A copy", "S copy", "T copy", "P", "G"].concat(["A", "S", "T", "P", "G"]));
  expect(await s.children(null)).toEqual(["A", "A copy", "B"]);
  expect(await s.children("A copy")).toEqual(["G", "P", "S copy"]);
  expect(await s.rev()).toBe(rev + 1);
  const names = await s.byName();
  for (const n of ["G", "P", "Blue"]) {
    const [original, copy] = names.get(n) ?? [];
    expect(copy?.id).toBeTruthy();
    expect(copy?.id).not.toBe(original?.id);
    expect(copy?.type).toBe(original?.type);
  }
  // The copy is selected as a click on its row selects it: its row, and its objects P and G.
  await expect.poll(s.selected).toEqual([2, 5, 6]);
  expect(s.duplicates()[0].command.input).toEqual({
    nodeIds: [await s.id("A")],
    layerSuffix: " copy",
  });

  // With the original hidden, the canvas draws the copy.
  await page.getByRole("button", { name: "Hide A", exact: true }).click();
  await expect(s.row("A")).toHaveCSS("opacity", "0.5");
  await expect.poll(s.top).toBe("RBG");
  await page.keyboard.press("Control+Z");
  await expect(s.row("A")).toHaveCSS("opacity", "1");

  await page.keyboard.press("Control+Z");
  await expect.poll(s.rowNames).toEqual(["B", "H", "A", "S", "T", "P", "G"]);
  expect(await s.children(null)).toEqual(["A", "B"]);
});

test("a duplicated sub-Layer stays in its parent Layer, its own sub-Layer renamed too", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  await s.pick("S");
  await s.duplicate();
  await expect.poll(() => s.children("A")).toEqual(["G", "P", "S", "S copy"]);
  expect(await s.children("S copy")).toEqual(["T copy"]);
  expect(await s.children(null)).toEqual(["A", "B"]);
});

test("two object rows in different Groups each copy above their own original, names unchanged", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  await page.getByRole("button", { name: "Expand G" }).click();
  await page.getByRole("button", { name: "Expand H" }).click();
  await s.pick("Blue");
  await s.pick("Green", ["Shift"]);
  await s.menu.click();
  await expect(s.item).toHaveText("Duplicate Selection");
  await s.item.click();
  await expect.poll(() => s.children("G")).toEqual(["Blue", "Blue"]);
  expect(await s.children("H")).toEqual(["Green", "Green"]);
  // The copies, the upper rows, are the Selection.
  await expect(
    s.row("Blue").first().getByRole("button", { name: "Blue", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    s.row("Blue").nth(1).getByRole("button", { name: "Blue", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("a clipped Layer's copy still clips, and a locked, hidden Layer's copy is locked and hidden", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  // P on top of A becomes A's Clipping Path.
  const a = await s.id("A");
  await call(request, "kalamo_node_reparent", {
    docId: s.docId,
    moves: [{ nodeId: await s.id("P"), parentId: a }],
  });
  await call(request, "kalamo_mask_make", { docId: s.docId, layerId: a });
  await call(request, "kalamo_node_update", {
    docId: s.docId,
    updates: [{ nodeId: await s.id("B"), patch: { locked: true, visible: false } }],
  });
  await expect(s.row("B")).toHaveCSS("opacity", "0.5");

  await s.pick("A");
  await s.pick("B", ["Shift"]);
  await s.duplicate();
  await expect.poll(() => s.children(null)).toEqual(["A", "A copy", "B", "B copy"]);
  const copies = (await s.byName()).get("A copy")?.[0] as Entry;
  const nodes = (
    await call(request, "kalamo_node_get", {
      docId: s.docId,
      nodeIds: [copies.children?.at(-1)?.id, (await s.byName()).get("B copy")?.[0]?.id],
      detail: "full",
    })
  ).structuredContent.nodes;
  expect(nodes[0]).toMatchObject({ name: "P", clipping: true });
  expect(nodes[1]).toMatchObject({ name: "B copy", locked: true, visible: false });
});

test("a row in a locked Layer is skipped, and alone it disables the entry", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  await call(request, "kalamo_node_update", {
    docId: s.docId,
    updates: [{ nodeId: await s.id("B"), patch: { locked: true } }],
  });
  await expect(s.row("H")).toHaveCSS("opacity", "0.5");
  await s.pick("H");
  await s.menu.click();
  await expect(s.item).toHaveText('Duplicate "H"');
  await expect(s.item).toHaveAttribute("aria-disabled", "true");
  await s.item.click({ force: true });
  await page.keyboard.press("Escape");

  await s.pick("P", ["Shift"]);
  await s.duplicate();
  await expect.poll(() => s.children("A")).toEqual(["G", "P", "P", "S"]);
  expect(await s.children("B")).toEqual(["H"]);
  expect(s.duplicates()).toHaveLength(1);
});

test("the entry is disabled with an empty Selection, and works from the keyboard", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  await s.menu.focus();
  await page.keyboard.press("Enter");
  await expect(s.item).toBeFocused();
  await expect(s.item).toHaveText("Duplicate Selection");
  await expect(s.item).toHaveAttribute("aria-disabled", "true");
  // A disabled entry does nothing and the menu stays open, as in the menu bar.
  await page.keyboard.press("Enter");
  await expect(s.item).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(s.item).toBeHidden();
  await expect(s.menu).toBeFocused();

  await s.pick("P");
  await s.menu.focus();
  await page.keyboard.press("Enter");
  await expect(s.item).toBeFocused();
  // The focused entry shows the menu bar's focus colour.
  await expect(s.item).toHaveCSS("background-color", "rgb(220, 230, 255)");
  await expect(s.item).toHaveText('Duplicate "P"');
  await page.keyboard.press("Enter");
  await expect.poll(() => s.children("A")).toEqual(["G", "P", "P", "S"]);
  await expect(s.item).toBeHidden();
  // The keys go back to the Document.
  await expect(s.menu).not.toBeFocused();
  expect(s.duplicates()).toHaveLength(1);
});

test("a Layer row is forgotten when the Selection changes elsewhere, even to an equal empty one", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  // T is empty: its row selects no object, only the row.
  await s.pick("T");
  await expect.poll(s.selected).toEqual([4]);
  await s.menu.click();
  await expect(s.item).toHaveText('Duplicate "T"');
  await expect(s.item).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("Escape");

  // A canvas click on P, then on empty canvas: the Selection is empty again, the row stays gone.
  const canvas = page.getByTestId("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.click(box.x + box.width / 2 - 100 + 15, box.y + box.height / 2);
  await expect.poll(s.selected).toEqual([5]);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 90);
  await expect.poll(s.selected).toEqual([]);
  await s.menu.click();
  await expect(s.item).toHaveText("Duplicate Selection");
  await expect(s.item).toHaveAttribute("aria-disabled", "true");
});

test("a viewer's entry is disabled, and an Agent's node_duplicate of a Layer shows up live", async ({
  page,
  request,
}) => {
  const s = await setup(page, request, { viewer: true });
  await s.pick("P");
  await s.menu.click();
  await expect(s.item).toHaveAttribute("aria-disabled", "true");
  await s.item.click({ force: true });
  expect(s.duplicates()).toHaveLength(0);
  await page.keyboard.press("Escape");

  await call(request, "kalamo_node_duplicate", { docId: s.docId, nodeIds: [await s.id("B")] });
  await expect.poll(s.rowNames).toEqual(["B", "H", "B", "H", "A", "S", "T", "P", "G"]);
});
