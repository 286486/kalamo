import { expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #64: the Gradient panel and the Gradient tool edit the active paint, one undo step per gesture,
// and midpoints draw on the canvas as render draws them (ADR-0081).

type Stop = { offset: number; color: string; midpoint?: number };

/** Opens `docId` at Actual Size; `at` maps document points to the page. */
async function open(page: Page, docId: string) {
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;
  const drag = async (from: [number, number], to: [number, number]) => {
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    await page.mouse.move(...at(...to), { steps: 6 });
    await page.mouse.up();
  };
  return { at, drag };
}

test("the Gradient panel applies, retypes, adds and colours a stop, moves a midpoint and reverses", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Panel",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const [id] = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [{ type: "rect", parentId, x: 20, y: 10, width: 100, height: 60 }],
    })
  ).structuredContent.createdIds as [string];
  const fill = async () =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent.nodes[0].appearance.fills[0];
  const stops = async () => ((await fill()).gradient?.stops ?? []) as Stop[];

  const { at } = await open(page, docId);
  await page.mouse.click(...at(70, 40));
  await page.keyboard.press("Control+F9");
  const panel = page.getByRole("region", { name: "Gradient" });
  await expect(panel).toBeVisible();

  await panel.getByRole("button", { name: "Gradient thumbnail" }).click();
  await expect
    .poll(fill)
    .toMatchObject({ type: "gradient", gradient: { type: "linear", start: { x: 20, y: 40 } } });

  await panel.getByLabel("Type").selectOption("radial");
  await expect.poll(async () => (await fill()).gradient.type).toBe("radial");

  // A click below the slider adds a stop there, selected, in the colour the gradient has.
  const slider = panel.getByRole("group", { name: "Gradient slider" });
  const s = await slider.boundingBox();
  if (!s) throw new Error("no slider");
  await page.mouse.click(s.x + s.width / 2, s.y + 36);
  await expect.poll(async () => (await stops()).map((t) => t.offset)).toEqual([0, 0.5, 1]);
  await panel.getByLabel("Stop color").fill("#ff0000");
  await expect.poll(async () => (await stops())[1]?.color).toBe("#FF0000");
  await panel.getByLabel("Opacity %").fill("50");
  await panel.getByLabel("Opacity %").press("Enter");
  await expect.poll(async () => (await stops())[1]?.color).toBe("#FF000080");

  // The first span's midpoint diamond, dragged left.
  const m = await panel.getByRole("button", { name: "Midpoint 1" }).boundingBox();
  if (!m) throw new Error("no midpoint");
  await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
  await page.mouse.down();
  await page.mouse.move(m.x + m.width / 2 - 30, m.y + m.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await stops())[0]?.midpoint).toBeLessThan(0.4);
  const before = await stops();

  await panel.getByRole("button", { name: "⇄" }).click();
  await expect
    .poll(async () => (await stops()).map((t) => t.color))
    .toEqual([before[2]?.color, "#FF000080", before[0]?.color]);
  expect((await stops())[1]?.midpoint).toBeCloseTo(1 - (before[0]?.midpoint ?? 0), 5);

  // Undo takes back the Reverse alone.
  await page.keyboard.press("Control+Z");
  await expect.poll(stops).toEqual(before);
});

test("the Gradient tool drags a vector on a turned rect, tears a stop off and moves a midpoint", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Tool",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const three = [
    { offset: 0, color: "#000000" },
    { offset: 0.5, color: "#FF0000" },
    { offset: 1, color: "#FFFFFF" },
  ];
  const [id] = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [
        {
          type: "rect",
          parentId,
          x: 60,
          y: 30,
          width: 80,
          height: 40,
          appearance: { fills: [{ type: "gradient", gradient: { type: "linear", stops: three } }] },
        },
      ],
    })
  ).structuredContent.createdIds as [string];
  await call(request, "kalamo_node_transform", { docId, nodeIds: [id], rotate: 90 });
  const node = async () =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent.nodes[0];
  const gradient = async () => (await node()).appearance.fills[0].gradient;
  const { transform: m } = await node();
  /** A document point in the rect's own coordinates. */
  const own = (x: number, y: number) => {
    const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
    const det = a * d - b * c;
    const [px, py] = [x - e, y - f];
    const r = (v: number) => Math.round(v * 1000) / 1000 || 0;
    return { x: r((d * px - c * py) / det), y: r((a * py - b * px) / det) };
  };

  const { at, drag } = await open(page, docId);
  await page.mouse.click(...at(100, 50));
  await page.keyboard.press("g");
  await expect(page.getByRole("button", { name: "Gradient Tool (G)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Across the turned rect, left to right in the Document, away from its Annotator.
  await drag([85, 35], [115, 35]);
  await expect.poll(gradient).toMatchObject({ start: own(85, 35), end: own(115, 35) });
  const { rev } = (await call(request, "kalamo_doc_changes", { docId, sinceRev: 0 }))
    .structuredContent;

  // The middle stop sits 12 px below the bar at its offset; dragged well away, it goes.
  await drag([100, 47], [100, 90]);
  await expect.poll(async () => (await gradient()).stops.length).toBe(2);

  // The one midpoint now sits 9 px above the bar, halfway; to 20% of the way.
  await drag([100, 26], [91, 26]);
  await expect.poll(async () => (await gradient()).stops[0].midpoint).toBeCloseTo(0.2, 1);
  const changes = (await call(request, "kalamo_doc_changes", { docId, sinceRev: rev }))
    .structuredContent.changes;
  expect(changes).toHaveLength(2);

  // Undo takes back the midpoint drag alone.
  await page.keyboard.press("Control+Z");
  await expect.poll(async () => (await gradient()).stops).toEqual([three[0], three[2]]);
});

test("the canvas draws a midpoint as render does", async ({ page, request }) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Midpoint",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const stops = [
    { offset: 0, color: "#000000", midpoint: 0.25 },
    { offset: 1, color: "#FFFFFF" },
  ];
  await call(request, "kalamo_node_create", {
    docId,
    nodes: [
      {
        type: "rect",
        parentId,
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        appearance: { fills: [{ type: "gradient", gradient: { type: "linear", stops } }] },
      },
    ],
  });
  const rendered = await call(request, "kalamo_render", { docId });
  const png = rendered.content.find((c: { type: string }) => c.type === "image").data as string;
  const { scale, docRect } = rendered.structuredContent.viewport;
  await open(page, docId);
  const probes = [30, 50, 100].map((x) => ({ x, y: 50 }));
  const read = () =>
    page.getByTestId("canvas").evaluate(
      async (el: HTMLCanvasElement, { probes, png, scale, docRect }) => {
        const k = el.width / el.getBoundingClientRect().width;
        const ctx = el.getContext("2d");
        const image = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${png}`)).blob(),
        );
        const off = new OffscreenCanvas(image.width, image.height).getContext("2d");
        off?.drawImage(image, 0, 0);
        return probes.map(({ x, y }) => {
          const [px, py] = [(el.width / k / 2 + x - 100) * k, (el.height / k / 2 + y - 50) * k];
          const canvas = ctx?.getImageData(px, py, 1, 1).data[0] ?? -1;
          const [rx, ry] = [(x - docRect.x) * scale, (y - docRect.y) * scale];
          return [canvas, off?.getImageData(rx, ry, 1, 1).data[0] ?? -1];
        });
      },
      { probes, png, scale, docRect },
    );
  await expect
    .poll(async () => (await read()).every(([c, r]) => Math.abs((c ?? 0) - (r ?? 0)) <= 4))
    .toBe(true);
  // A quarter of the way along, mid-grey.
  expect(Math.abs(((await read())[1]?.[0] ?? 0) - 128)).toBeLessThanOrEqual(4);
});
