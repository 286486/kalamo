import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

interface Entry {
  id: string;
  name: string;
  children?: Entry[];
}

/**
 * Layer A: Red (0–60) under Green (20–80), and Sublayer Sub. Layer B, on top: Group G holding
 * Blue (40–100). All 100 tall on a 200 × 100 Artboard.
 */
async function setup(page: Page, request: APIRequestContext) {
  const { docId, defaultLayerId: a } = (
    await call(request, "kalamo_doc_create", {
      name: "Layers drag",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const rect = (name: string, x: number, color: string) => ({
    type: "rect",
    name,
    x,
    y: 0,
    width: 60,
    height: 100,
    appearance: { fills: [{ color }] },
  });
  await call(request, "kalamo_node_update", {
    docId,
    updates: [{ nodeId: a, patch: { name: "A" } }],
  });
  const { createdIds } = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [
        { ...rect("Red", 0, "#FF0000"), parentId: a },
        { ...rect("Green", 20, "#00FF00"), parentId: a },
        { type: "layer", name: "Sub", parentId: a },
        { type: "layer", name: "B" },
      ],
    })
  ).structuredContent;
  await call(request, "kalamo_node_create", {
    docId,
    nodes: [
      {
        type: "group",
        name: "G",
        parentId: createdIds[3],
        children: [rect("Blue", 40, "#0000FF")],
      },
    ],
  });
  const ids = new Map<string, string>();
  const outline = async () => {
    const { nodes, rev } = (await call(request, "kalamo_doc_outline", { docId, depth: 9 }))
      .structuredContent as { nodes: Entry[]; rev: number };
    const walk = (es: Entry[]) => {
      for (const e of es) {
        ids.set(e.name, e.id);
        walk(e.children ?? []);
      }
    };
    walk(nodes);
    return { nodes, rev };
  };
  await outline();
  const id = (name: string) => ids.get(name) as string;
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

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  // The colour on top at x 30 (Red and Green), 50 (all three) and 70 (Green and Blue).
  const top = () =>
    page.getByTestId("canvas").evaluate((el: HTMLCanvasElement) => {
      const k = el.width / el.getBoundingClientRect().width;
      const ctx = el.getContext("2d");
      return [30, 50, 70]
        .map((x) => {
          const [px, py] = [(el.width / k / 2 + x - 100) * k, (el.height / k / 2) * k];
          const [r = 0, g = 0, b = 0] = ctx?.getImageData(px, py, 1, 1).data ?? [];
          return r > 200 && g < 50 ? "R" : g > 200 && r < 50 ? "G" : b > 200 && r < 50 ? "B" : "?";
        })
        .join("");
    });
  await expect.poll(top).toBe("GBB");
  const row = (name: string) => page.getByRole("listitem", { name, exact: true });
  const rowNames = () =>
    page.getByRole("listitem").evaluateAll((els) => els.map((e) => e.ariaLabel));
  /** Presses on `from`'s row and moves over `to`'s at `y`, its height's fraction from the top. */
  const dragOver = async (from: string, to: string, y: number) => {
    const a = await row(from).boundingBox();
    const b = await row(to).boundingBox();
    if (!a || !b) throw new Error("no row");
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height * y, { steps: 5 });
    // Chromium dispatches the drag's first dragover on the move after the one that starts it.
    await page.mouse.move(b.x + b.width / 2 + 1, b.y + b.height * y);
  };
  const drag = async (from: string, to: string, y: number) => {
    await dragOver(from, to, y);
    await page.mouse.up();
  };
  return { docId, id, children, rev, top, row, rowNames, dragOver, drag };
}

test("dragging a Path's row onto a Group in another Layer puts it on top there, geometry unchanged, and one Ctrl+Z restores it (ADR-0075)", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  const geometry = async () => {
    const { x, y, width, height, transform } = (
      await call(request, "kalamo_node_get", {
        docId: s.docId,
        nodeIds: [s.id("Red")],
        detail: "full",
      })
    ).structuredContent.nodes[0];
    return { x, y, width, height, transform };
  };
  const before = await geometry();
  const rev = await s.rev();

  await s.dragOver("Red", "G", 0.5);
  await expect(s.row("G")).toHaveAttribute("data-drop", "onto");
  await page.mouse.up();
  await expect(s.row("Red")).toBeHidden();
  await page.getByRole("button", { name: "Expand G" }).click();
  await expect.poll(s.rowNames).toEqual(["B", "G", "Red", "Blue", "A", "Sub", "Green"]);
  expect(await s.children("G")).toEqual(["Blue", "Red"]);
  await expect.poll(s.top).toBe("RRB");
  expect(await geometry()).toEqual(before);
  expect(await s.rev()).toBe(rev + 1);

  await page.keyboard.press("Control+Z");
  await expect.poll(s.top).toBe("GBB");
  expect(await s.children("A")).toEqual(["Red", "Green", "Sub"]);
  await expect.poll(s.rowNames).toEqual(["B", "G", "Blue", "A", "Sub", "Green", "Red"]);
});

test("dragging a row between two siblings restacks it, and the canvas draws the new order", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  // The top quarter of Green's row: the gap above it.
  await s.dragOver("Red", "Green", 0.1);
  await expect(s.row("Green")).toHaveAttribute("data-drop", "above");
  await page.mouse.up();
  await expect.poll(s.rowNames).toEqual(["B", "G", "A", "Sub", "Red", "Green"]);
  expect(await s.children("A")).toEqual(["Green", "Red", "Sub"]);
  await expect.poll(s.top).toBe("RBB");
});

test("a Sublayer drags to the top level and back", async ({ page, request }) => {
  const s = await setup(page, request);
  await s.drag("Sub", "B", 0.1);
  await expect.poll(s.rowNames).toEqual(["Sub", "B", "G", "A", "Green", "Red"]);
  expect(await s.children(null)).toEqual(["A", "B", "Sub"]);

  await s.drag("Sub", "A", 0.5);
  await expect.poll(s.rowNames).toEqual(["B", "G", "A", "Sub", "Green", "Red"]);
  expect(await s.children(null)).toEqual(["A", "B"]);
  expect(await s.children("A")).toEqual(["Red", "Green", "Sub"]);
});

test("two selected rows dragged together keep their relative order", async ({ page, request }) => {
  const s = await setup(page, request);
  await page.getByRole("button", { name: "Green", exact: true }).click();
  await page.getByRole("button", { name: "Red", exact: true }).click({ modifiers: ["Shift"] });
  await s.drag("Red", "B", 0.5);
  await expect.poll(s.rowNames).toEqual(["B", "Green", "Red", "G", "A", "Sub"]);
  expect(await s.children("B")).toEqual(["G", "Red", "Green"]);
  await expect.poll(s.top).toBe("GGG");
  await page.keyboard.press("Control+Z");
  await expect.poll(s.top).toBe("GBB");
  expect(await s.children("A")).toEqual(["Red", "Green", "Sub"]);
});

test("dragging a Clip Group's Clipping Path to another Layer unclips it, and the Clip Group becomes a Group (ADR-0071)", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  await call(request, "kalamo_mask_make", {
    docId: s.docId,
    clipNodeId: s.id("Green"),
    contentIds: [s.id("Red")],
  });
  await page.getByRole("button", { name: "Expand <Clip Group>" }).click();
  await expect(s.row("Green")).toBeVisible();

  await s.drag("Green", "B", 0.5);
  await expect(s.row("<Group>")).toBeVisible();
  await expect(s.row("<Clip Group>")).toBeHidden();
  const green = (
    await call(request, "kalamo_node_get", {
      docId: s.docId,
      nodeIds: [s.id("Green")],
      detail: "full",
    })
  ).structuredContent.nodes[0];
  expect(green.clipping ?? false).toBe(false);
  expect(await s.children("B")).toEqual(["G", "Green"]);
});

test("a drop into a descendant, a Layer onto a Group, or into a locked container shows no indicator and sends nothing", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  await page.getByRole("button", { name: "Expand G" }).click();
  await call(request, "kalamo_node_update", {
    docId: s.docId,
    updates: [{ nodeId: s.id("Sub"), patch: { locked: true } }],
  });
  await expect(page.getByRole("button", { name: "Unlock Sub" })).toBeVisible();
  const rev = await s.rev();
  const refused = async (from: string, to: string, y: number) => {
    await s.dragOver(from, to, y);
    await expect(s.row(to)).not.toHaveAttribute("data-drop");
    await page.mouse.up();
  };
  await refused("B", "Blue", 0.1); // B into its own descendant G.
  await refused("G", "Blue", 0.9); // G into itself.
  await refused("Sub", "G", 0.5); // A Layer into a Group.
  await refused("Red", "Sub", 0.5); // Into a locked Sublayer.
  await expect(page.locator("[data-drop]")).toHaveCount(0);
  expect(await s.rev()).toBe(rev);
  await expect.poll(s.rowNames).toEqual(["B", "G", "Blue", "A", "Sub", "Green", "Red"]);
});

test("an Agent's concurrent node_reparent shows up live in the open panel", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  await call(request, "kalamo_node_reparent", {
    docId: s.docId,
    moves: [{ nodeId: s.id("Green"), parentId: s.id("B") }],
  });
  await expect.poll(s.rowNames).toEqual(["B", "Green", "G", "A", "Sub", "Red"]);
  await expect.poll(s.top).toBe("GGG");
});
