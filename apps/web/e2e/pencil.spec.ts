import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #83: the Pencil draws freehand paths that commit once, closes loops and redraws selected paths.
test("the Pencil draws a stroke, redraws part of it, and closes a loop with its options", async ({
  page,
  request,
}) => {
  const { docId, rev } = (
    await call(request, "zibel_doc_create", {
      name: "Pencil",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;
  const paths = async () => {
    const found = (await call(request, "zibel_node_query", { docId, types: ["path"] }))
      .structuredContent.nodes as { id: string }[];
    if (found.length === 0) return [];
    const nodeIds = found.map((n) => n.id);
    return (await call(request, "zibel_node_get", { docId, nodeIds, detail: "full" }))
      .structuredContent.nodes as {
      id: string;
      d: string;
      appearance: { fills: unknown[] };
    }[];
  };
  const changes = async () =>
    (await call(request, "zibel_doc_changes", { docId, sinceRev: rev })).structuredContent
      .changes as unknown[];
  /** A drag through the points in document coordinates. */
  const drag = async (points: [number, number][]) => {
    const [first, ...rest] = points;
    if (!first) return;
    await page.mouse.move(...at(...first));
    await page.mouse.down();
    for (const p of rest) await page.mouse.move(...at(...p));
    await page.mouse.up();
  };
  const range = (n: number, f: (t: number) => [number, number]) =>
    Array.from({ length: n + 1 }, (_, i) => f(i / n));

  await page.keyboard.press("n");
  await expect(page.getByRole("button", { name: "Pencil Tool (N)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // A wave: one Transaction with a fitted, unfilled path, which stays selected.
  await drag(range(40, (t) => [20 + 160 * t, 40 + 20 * Math.sin(t * 2 * Math.PI)]));
  await expect.poll(async () => (await paths()).length).toBe(1);
  const [wave] = await paths();
  expect(wave?.d).toMatch(/^M 20 40 C .* 180 40$/);
  expect(wave?.appearance.fills).toEqual([]);
  expect(await changes()).toHaveLength(1);
  await expect(page.getByRole("button", { name: "<Path>", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // From on the wave near its start, down and back onto it: one path_edit on the same path.
  const onWave = (x: number) => 40 + 20 * Math.sin(((x - 20) / 160) * 2 * Math.PI);
  await drag(range(20, (t) => [30 + 20 * t, onWave(30 + 20 * t) + 25 * Math.sin(t * Math.PI)]));
  await expect.poll(async () => (await changes()).length).toBe(2);
  const [redrawn, ...more] = await paths();
  expect(more).toEqual([]);
  expect(redrawn?.id).toBe(wave?.id);
  expect(redrawn?.d).not.toBe(wave?.d);
  expect(redrawn?.d).toMatch(/^M 20 40 .* 180 40$/);

  // Pencil Tool Options: Fill new pencil strokes; a loop ending near its start closes, filled.
  await page.getByRole("button", { name: "Pencil Tool (N)" }).dblclick();
  const options = page.getByRole("dialog", { name: "Pencil Tool Options" });
  await options.getByLabel("Fill new pencil strokes").check();
  await options.getByRole("button", { name: "OK" }).click();
  await expect(options).toBeHidden();
  await page.keyboard.press("Control+Shift+a");
  await drag(
    range(40, (t) => {
      const a = t * 1.9 * Math.PI;
      return [100 + 30 * Math.cos(a), 50 + 30 * Math.sin(a)];
    }),
  );
  await expect.poll(async () => (await paths()).length).toBe(2);
  const loop = (await paths()).find((p) => p.id !== wave?.id);
  expect(loop?.d).toMatch(/ Z$/);
  expect(loop?.appearance.fills).toMatchObject([{ color: "#FFFFFF" }]);
});
