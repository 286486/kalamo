import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

interface Entry {
  id: string;
  name: string;
  children?: Entry[];
}

/**
 * Layer A: path P (10–40) and Red (60–90); Layer B, on top: Blue (110–140). All 10–40 tall on a
 * 200 × 100 Artboard, shown at 100%. `viewer` opens it as a viewer would.
 */
async function setup(page: Page, request: APIRequestContext, { viewer = false } = {}) {
  const { docId, defaultLayerId: a } = (
    await call(request, "kalamo_doc_create", {
      name: "Alt-drag",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const fill = (color: string) => ({ appearance: { fills: [{ color }] } });
  const rect = (name: string, x: number, color: string) => ({
    type: "rect",
    name,
    x,
    y: 10,
    width: 30,
    height: 30,
    ...fill(color),
  });
  await call(request, "kalamo_node_update", {
    docId,
    updates: [{ nodeId: a, patch: { name: "A" } }],
  });
  const [p, red, b] = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [
        {
          type: "path",
          name: "P",
          parentId: a,
          d: "M10 10 L40 10 L40 40 L10 40 Z",
          ...fill("#000000"),
        },
        { ...rect("Red", 60, "#FF0000"), parentId: a },
        { type: "layer", name: "B" },
      ],
    })
  ).structuredContent.createdIds as [string, string, string];
  const [blue] = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [{ ...rect("Blue", 110, "#0000FF"), parentId: b }],
    })
  ).structuredContent.createdIds as [string];

  /** Each Layer's children as [name, id], bottom first. */
  const layers = async () => {
    const { nodes } = (await call(request, "kalamo_doc_outline", { docId, depth: 2 }))
      .structuredContent as { nodes: Entry[] };
    return nodes.map((l) => (l.children ?? []).map((c) => [c.name, c.id]));
  };
  /** The id of Layer `layer`'s `i`-th child, bottom first. */
  const idAt = async (layer: number, i: number) => (await layers())[layer]?.[i]?.[1] as string;
  const names = async () => (await layers()).map((l) => l.map(([name]) => name));
  const boundsOf = async (id: string) =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id] })).structuredContent?.nodes[0]
      .geometricBounds;

  // The Commands the page sends; the role the Document socket gives it rewritten for a viewer.
  const sent: { type: string }[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const command = JSON.parse(String(m)).command;
      if (command) sent.push(command);
      server.send(m);
    });
    server.onMessage((m) => {
      const msg = JSON.parse(String(m));
      ws.send(viewer && msg.type === "document" ? JSON.stringify({ ...msg, role: "viewer" }) : m);
    });
  });

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("overlay").boundingBox();
  if (!box) throw new Error("no canvas");
  /** The page point of Artboard point (x, y). */
  const at = (x: number, y: number): [number, number] => [
    box.x + box.width / 2 + x - 100,
    box.y + box.height / 2 + y - 50,
  ];
  /**
   * Drags from Artboard point `from` by (dx, dy) in two halves; `alt` says when Alt is down:
   * from the press, from halfway, until halfway, or never.
   */
  const drag = async (
    from: [number, number],
    [dx, dy]: [number, number],
    alt: "all" | "late" | "early" | "none",
  ) => {
    const [x, y] = at(...from);
    await page.mouse.move(x, y);
    if (alt === "all" || alt === "early") await page.keyboard.down("Alt");
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
    if (alt === "late") await page.keyboard.down("Alt");
    if (alt === "early") await page.keyboard.up("Alt");
    await page.mouse.move(x + dx, y + dy, { steps: 5 });
    await page.mouse.up();
    if (alt === "all" || alt === "late") await page.keyboard.up("Alt");
  };
  const row = (name: string) => page.getByRole("button", { name, exact: true });
  return { docId, p, red, blue, idAt, names, boundsOf, sent, at, drag, row };
}

test("an Alt-drag leaves the path and drops a selected copy above it, undone in one step (ADR-0076)", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  await s.drag([25, 25], [0, 40], "all");
  await expect.poll(s.names).toEqual([["P", "P", "Red"], ["Blue"]]);
  expect(await s.idAt(0, 0)).toBe(s.p);
  expect(await s.boundsOf(s.p)).toMatchObject({ x: 10, y: 10 });
  expect(await s.boundsOf(await s.idAt(0, 1))).toMatchObject({
    x: 10,
    y: 50,
    width: 30,
    height: 30,
  });
  expect(s.sent.map((c) => c.type)).toEqual(["duplicate"]);
  // The Layers panel lists top first: the copy is selected, the original is not.
  await expect(s.row("P").nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(s.row("P").nth(1)).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("Control+z");
  await expect.poll(s.names).toEqual([["P", "Red"], ["Blue"]]);
  expect(await s.boundsOf(s.p)).toMatchObject({ x: 10, y: 10 });
});

test("Alt counts at the release: pressed mid-drag copies, released before the button moves", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  await s.drag([25, 25], [0, 40], "late");
  await expect.poll(s.names).toEqual([["P", "P", "Red"], ["Blue"]]);

  await s.drag([75, 25], [0, 40], "early");
  await expect.poll(async () => (await s.boundsOf(s.red))?.y).toBe(50);
  expect(await s.names()).toEqual([["P", "P", "Red"], ["Blue"]]);

  await s.drag([125, 25], [0, 40], "none");
  await expect.poll(async () => (await s.boundsOf(s.blue))?.y).toBe(50);
  expect(await s.names()).toEqual([["P", "P", "Red"], ["Blue"]]);
  expect(s.sent.map((c) => c.type)).toEqual(["duplicate", "transform", "transform"]);
});

test("an Alt-drag of two Nodes in different Layers drops both above the topmost, in order", async ({
  page,
  request,
}) => {
  const s = await setup(page, request);
  await page.mouse.click(...s.at(75, 25));
  await page.keyboard.down("Shift");
  await page.mouse.click(...s.at(125, 25));
  await page.keyboard.up("Shift");
  await expect(s.row("Blue")).toHaveAttribute("aria-pressed", "true");
  // Dragging the lower one still puts the block above Blue, the topmost, in its Layer.
  await s.drag([75, 25], [0, 40], "all");
  await expect.poll(s.names).toEqual([
    ["P", "Red"],
    ["Blue", "Red", "Blue"],
  ]);
  expect(await s.boundsOf(await s.idAt(1, 1))).toMatchObject({ x: 60, y: 50 });
  expect(await s.boundsOf(await s.idAt(1, 2))).toMatchObject({ x: 110, y: 50 });
  await expect(s.row("Red").nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(s.row("Blue").nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(s.row("Red").nth(1)).toHaveAttribute("aria-pressed", "false");
});

test("a viewer's Alt-drag sends nothing, and an Agent's node_duplicate shows up live", async ({
  page,
  request,
}) => {
  const s = await setup(page, request, { viewer: true });
  await s.drag([25, 25], [0, 40], "all");
  await expect(s.row("P")).toHaveAttribute("aria-pressed", "true");
  expect(s.sent).toEqual([]);
  expect(await s.names()).toEqual([["P", "Red"], ["Blue"]]);

  await call(request, "kalamo_node_duplicate", {
    docId: s.docId,
    nodeIds: [s.red],
    offset: { x: 0, y: 40 },
  });
  await expect(s.row("Red")).toHaveCount(2);
  // The copy draws red at its new place; the tab's Selection is left alone.
  const [x, y] = s.at(75, 65);
  await expect
    .poll(() =>
      page.getByTestId("canvas").evaluate(
        (el: HTMLCanvasElement, [px, py]: [number, number]) => {
          const r = el.getBoundingClientRect();
          const k = el.width / r.width;
          const [red = 0, green = 0] =
            el.getContext("2d")?.getImageData((px - r.left) * k, (py - r.top) * k, 1, 1).data ?? [];
          return red > 200 && green < 50;
        },
        [x, y] as [number, number],
      ),
    )
    .toBe(true);
  await expect(s.row("P")).toHaveAttribute("aria-pressed", "true");
});
