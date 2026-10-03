import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #80: Direct Selection moves Anchors and Handles, converts a rect, and Delete opens paths.
test("Direct Selection moves an Anchor, converts a rect, breaks a Handle and deletes Anchors", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Direct",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const created = await call(request, "kalamo_node_create", {
    docId,
    nodes: [
      { type: "rect", parentId, x: 20, y: 10, width: 40, height: 40 },
      // A Smooth Anchor at (110, 60) with Handles at (100, 60) and (120, 60).
      { type: "path", parentId, d: "M 80 90 C 80 70 100 60 110 60 C 120 60 140 70 140 90" },
      { type: "path", parentId, d: "M 150 20 L 190 20 L 190 80 L 150 80" },
    ],
  });
  const [rect, curve, line] = created.structuredContent.createdIds as [string, string, string];
  const get = async (id: string) =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent?.nodes[0];

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  // At Actual Size the Artboard's centre (100, 50) stays at the canvas's centre.
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;
  const dragFrom = async (from: [number, number], to: [number, number]) => {
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    await page.mouse.move(...at(...to), { steps: 5 });
    await page.mouse.up();
  };

  await page.keyboard.press("a");
  await expect(page.getByRole("button", { name: "Direct Selection Tool (A)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Dragging one Anchor commits one path_edit Transaction.
  const { rev } = created.structuredContent;
  await dragFrom([190, 20], [190, 10]);
  await expect.poll(async () => (await get(line))?.d).toBe("M 150 20 L 190 10 L 190 80 L 150 80");
  const { changes } = (await call(request, "kalamo_doc_changes", { docId, sinceRev: rev }))
    .structuredContent;
  expect(changes).toMatchObject([{ actor: "user", updatedIds: [line] }]);

  // Dragging the rect's corner converts it to a path with the same id.
  await dragFrom([60, 50], [70, 60]);
  await expect
    .poll(async () => await get(rect))
    .toMatchObject({ id: rect, type: "path", d: "M 20 10 L 60 10 L 70 60 L 20 50 Z" });

  // Alt-dragging one Handle of the Smooth Anchor leaves the other where it was: a Corner.
  await page.mouse.click(...at(110, 60));
  await page.keyboard.down("Alt");
  await dragFrom([120, 60], [125, 50]);
  await page.keyboard.up("Alt");
  await expect
    .poll(async () => (await get(curve))?.d)
    .toBe("M 80 90 C 80 70 100 60 110 60 C 125 50 140 70 140 90");

  // A marquee takes an Anchor from each of two paths; Delete opens both there.
  await dragFrom([50, 0], [200, 15]);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await get(rect))?.d).toBe("M 70 60 L 20 50 L 20 10");
  await expect.poll(async () => (await get(line))?.d).toBe("M 190 80 L 150 80");
});

// #114: Direct Selection selects segments and Delete removes only them.
test("Direct Selection deletes selected segments, then the path", async ({ page, request }) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Segments",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const created = await call(request, "kalamo_node_create", {
    docId,
    nodes: [
      { type: "rect", parentId, x: 20, y: 60, width: 40, height: 30 },
      { type: "path", parentId, d: "M 20 20 L 60 20 L 100 20 L 140 20" },
    ],
  });
  const [rect, line] = created.structuredContent.createdIds as [string, string];
  const get = async (id: string) => {
    const result = await call(request, "kalamo_node_get", { docId, nodeIds: [id], detail: "full" });
    return result.isError
      ? JSON.parse(result.content[0].text).code
      : result.structuredContent.nodes[0];
  };

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;
  await page.keyboard.press("a");

  // The line's middle segment, then Shift for the rect's top one: the rect stays live meanwhile.
  await page.mouse.click(...at(80, 20));
  await page.keyboard.down("Shift");
  await page.mouse.click(...at(40, 60));
  await page.keyboard.up("Shift");
  expect(await get(rect)).toMatchObject({ type: "rect" });

  const { rev } = created.structuredContent;
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await get(line))?.d).toBe("M 20 20 L 60 20 M 100 20 L 140 20");
  await expect
    .poll(async () => await get(rect))
    .toMatchObject({ id: rect, type: "path", d: "M 60 60 L 60 90 L 20 90 L 20 60" });
  // One Transaction per path.
  const { changes } = (await call(request, "kalamo_doc_changes", { docId, sinceRev: rev }))
    .structuredContent;
  expect(changes).toMatchObject([{ updatedIds: [line] }, { updatedIds: [rect] }]);

  // Both paths stay selected with nothing in them: a second Delete removes them.
  await page.keyboard.press("Delete");
  await expect.poll(() => get(line)).toBe("NODE_NOT_FOUND");
  await expect.poll(() => get(rect)).toBe("NODE_NOT_FOUND");
});

// #116: the Anchors bar converts the selected segments' ends to Smooth, then to Corner.
test("the Anchors bar converts selected segments to smooth and corner", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Convert",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const created = await call(request, "kalamo_node_create", {
    docId,
    nodes: [
      { type: "rect", parentId, x: 20, y: 60, width: 40, height: 30 },
      { type: "path", parentId, d: "M 100 40 C 100 20 140 20 140 40 C 140 60 180 60 180 40" },
    ],
  });
  const [rect, curve] = created.structuredContent.createdIds as [string, string];
  const get = async (id: string) =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent?.nodes[0];
  const changesSince = async (sinceRev: number) =>
    (await call(request, "kalamo_doc_changes", { docId, sinceRev })).structuredContent;

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;
  const bar = page.getByRole("toolbar", { name: "Anchors" });
  await page.keyboard.press("a");

  // A segment shows the bar; a path selected whole is no target.
  await page.mouse.click(...at(120, 25));
  await expect(bar).toBeVisible();
  await page.mouse.move(...at(95, 10));
  await page.mouse.down();
  await page.mouse.move(...at(190, 55), { steps: 5 });
  await page.mouse.up();
  await expect(bar).toHaveCount(0);
  // The curve's first segment and the rect's top one.
  await page.mouse.click(...at(120, 25));
  await page.keyboard.down("Shift");
  await page.mouse.click(...at(40, 60));
  await page.keyboard.up("Shift");
  await expect(bar).toBeVisible();

  // Smooth: the rect converts in place and curves; the curve's ends are an Endpoint and a Smooth
  // Anchor already, so it sends nothing.
  const { rev } = created.structuredContent;
  await bar.getByRole("button", { name: "Convert selected anchor points to smooth" }).click();
  await expect.poll(async () => (await get(rect))?.d ?? "").toContain("C");
  expect(await get(rect)).toMatchObject({ id: rect, type: "path" });
  const smoothed = await changesSince(rev);
  expect(smoothed.changes).toMatchObject([{ updatedIds: [rect] }]);

  // Corner: both paths' ends lose their Handles, one Transaction per path.
  await bar.getByRole("button", { name: "Convert selected anchor points to corner" }).click();
  await expect.poll(async () => (await get(rect))?.d).toBe("M 20 60 L 60 60 L 60 90 L 20 90 Z");
  await expect
    .poll(async () => (await get(curve))?.d)
    .toBe("M 100 40 L 140 40 C 140 40 180 60 180 40");
  const cornered = await changesSince(smoothed.rev);
  expect(cornered.changes).toHaveLength(2);

  await page.keyboard.press("v");
  await expect(bar).toHaveCount(0);
});

// #298, ADR-0110: a drag made before the answer to the person's own Add Anchor click waits for it,
// and moves the Anchor pressed once the click's Anchor is in the path.
test("a drag made before an Add Anchor click's answer moves the Anchor pressed", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Renumbered",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  // A square around a hole running (40, 40), (40, 60), (60, 60), (60, 40).
  const [id] = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [
        {
          type: "path",
          parentId,
          d: "M20 20 L80 20 L80 80 L20 80 Z M40 40 L40 60 L60 60 L60 40 Z",
          appearance: { fills: [{ color: "#FF0000" }] },
        },
      ],
    })
  ).structuredContent.createdIds as [string];
  // The answer to the click, and every server message after it, wait until `release`.
  let clickId: string | null = null;
  let holding = true;
  const waiting: (() => void)[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m));
      const ops = msg.command?.input?.ops as { op: string }[] | undefined;
      if (ops?.some((o) => o.op === "add_anchor")) clickId = msg.id;
      server.send(m);
    });
    server.onMessage((m) => {
      const held = waiting.length > 0 || (clickId && JSON.parse(String(m)).commandId === clickId);
      if (holding && held) waiting.push(() => ws.send(m));
      else ws.send(m);
    });
  });
  const release = () => {
    holding = false;
    for (const send of waiting.splice(0)) send();
  };
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;
  const d = async () =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent.nodes[0].d as string;

  await page.keyboard.press("+");
  await page.mouse.click(...at(40, 48));
  await expect.poll(() => clickId).not.toBeNull();
  await page.keyboard.press("a");
  await page.mouse.move(...at(60, 40));
  await page.mouse.down();
  await page.mouse.move(...at(70, 40), { steps: 5 });
  await page.mouse.up();
  // The click is stored; the drag waits for its answer.
  await expect.poll(d).toMatch(/M 40 40 L 40 4\d(\.\d+)? L 40 60 L 60 60 L 60 40 Z$/);
  release();
  await expect.poll(d).toMatch(/M 40 40 L 40 4\d(\.\d+)? L 40 60 L 60 60 L 70 40 Z$/);
});
