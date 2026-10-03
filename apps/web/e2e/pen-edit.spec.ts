import { expect, test } from "@playwright/test";
import { pixel } from "./canvas.ts";
import { call } from "./mcp.ts";

// #81: the Pen continues and connects an Agent's paths; +, - and Shift+C edit their Anchors.
test("the Pen continues a path onto another, and +, - and Shift+C edit an Agent's path", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Pen edit",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const created = await call(request, "kalamo_node_create", {
    docId,
    nodes: [
      { type: "path", parentId, d: "M 20 20 L 60 20" },
      { type: "path", parentId, d: "M 100 20 L 140 20" },
      // A Smooth Anchor at (100, 80) between two Corners.
      { type: "path", parentId, d: "M 60 80 C 60 80 80 60 100 80 C 120 100 140 80 140 80" },
    ],
  });
  const [a, b, curve] = created.structuredContent.createdIds as [string, string, string];
  const get = async (id: string) =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [id], detail: "full" }))
      .structuredContent?.nodes[0];

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;

  // Continuing a's end, then clicking b's start: one Transaction leaves one path.
  const { rev } = created.structuredContent;
  await page.keyboard.press("p");
  await page.mouse.click(...at(60, 20));
  await page.mouse.click(...at(80, 40));
  await page.mouse.click(...at(100, 20));
  await expect
    .poll(async () => (await get(b))?.d)
    .toBe("M 20 20 L 60 20 L 80 40 L 100 20 L 140 20");
  const { changes } = (await call(request, "kalamo_doc_changes", { docId, sinceRev: rev }))
    .structuredContent;
  expect(changes).toMatchObject([{ actor: "user", updatedIds: [b], deletedIds: [a] }]);

  // + adds an Anchor at the middle of the curve's first segment, and - removes it again.
  await page.keyboard.press("=");
  await page.mouse.click(...at(72.5, 72.5));
  await expect.poll(async () => ((await get(curve))?.d.match(/C/g) ?? []).length).toBe(3);
  await page.keyboard.press("-");
  await page.mouse.click(...at(72.5, 72.5));
  await expect.poll(async () => ((await get(curve))?.d.match(/C/g) ?? []).length).toBe(2);

  // Shift+C: a click on the Smooth Anchor retracts its Handles.
  await page.keyboard.press("Shift+C");
  await expect(page.getByRole("button", { name: "Anchor Point Tool (Shift+C)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.mouse.click(...at(100, 80));
  await expect.poll(async () => (await get(curve))?.d).toBe("M 60 80 L 100 80 L 140 80");
});

// #115: Shift+C bends a Rectangle's segment, converting it in place, and a click retracts a Handle.
test("Shift+C reshapes a Rectangle's segment and retracts a Handle", async ({ page, request }) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Anchor Point",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const created = await call(request, "kalamo_node_create", {
    docId,
    nodes: [{ type: "rect", parentId, x: 40, y: 30, width: 120, height: 60 }],
  });
  const [rect] = created.structuredContent.createdIds as [string];
  const get = async () =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [rect], detail: "full" }))
      .structuredContent?.nodes[0];

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;

  // Dragging the top segment's middle up by 20 pulls out Handles 80/3 above both its Anchors.
  const { rev } = created.structuredContent;
  await page.keyboard.press("Shift+C");
  await page.mouse.move(...at(100, 30));
  await page.mouse.down();
  await page.mouse.move(...at(100, 10), { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await get())?.type).toBe("path");
  const bent = await get();
  expect(bent?.d).toMatch(/^M 40 30 C 40 3\.33\d* 160 3\.33\d* 160 30 L/);
  const { changes } = (await call(request, "kalamo_doc_changes", { docId, sinceRev: rev }))
    .structuredContent;
  expect(changes).toHaveLength(1);

  // A click on the start's Handle retracts it; the end's stays.
  await page.mouse.click(...at(40, 3.33));
  await expect.poll(async () => (await get())?.d).toMatch(/^M 40 30 C 40 30 160 3\.33\d* 160 30 L/);
});

// #282: an Agent's edit to the path the Pen is continuing ends the continuation, and the finish
// leaves the Agent's edit as it made it.
test("an Agent's edit to the path the Pen continues ends the continuation", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Pen race",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const created = await call(request, "kalamo_node_create", {
    docId,
    nodes: [{ type: "path", parentId, d: "M 20 20 L 60 20" }],
  });
  const [a] = created.structuredContent.createdIds as [string];
  const d = async () =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [a], detail: "full" }))
      .structuredContent?.nodes[0]?.d;

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;

  await page.keyboard.press("p");
  await page.mouse.click(...at(60, 20));
  await page.mouse.click(...at(80, 40));
  await call(request, "kalamo_path_edit", {
    docId,
    nodeId: a,
    ops: [{ op: "move_anchor", subpath: 0, index: 0, to: [20, 60] }],
  });
  await expect(page.getByRole("alert")).toContainText("the Pen stopped");
  const theirs = await d();
  await page.mouse.click(...at(100, 40));
  await page.keyboard.press("Enter");
  // The Agent's edit stays, and nothing the Pen drew lands on the path.
  await page.waitForTimeout(300);
  expect(theirs).toBe("M 20 60 L 60 20");
  expect(await d()).toBe(theirs);
});

// #290: an Agent's deletion of the path a held Pen press connects to drops only the connection;
// the release sends nothing, and Enter finishes the Pen's path as new art.
test("an Agent's deletion of the path a Pen press connects to drops the connection", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Pen connect race",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const created = await call(request, "kalamo_node_create", {
    docId,
    nodes: [{ type: "path", parentId, d: "M 100 20 L 140 20" }],
  });
  const [q] = created.structuredContent.createdIds as [string];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const paths = async () => {
    const { nodes } = (await call(request, "kalamo_node_query", { docId, types: ["path"] }))
      .structuredContent as { nodes: { id: string }[] };
    if (nodes.length === 0) return [];
    const got = await call(request, "kalamo_node_get", {
      docId,
      nodeIds: nodes.map((n) => n.id),
      detail: "full",
    });
    return (got.structuredContent.nodes as { d: string }[]).map((n) => n.d);
  };

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;

  await page.keyboard.press("p");
  await page.mouse.click(...at(20, 80));
  await page.mouse.click(...at(60, 80));
  await page.mouse.move(...at(140, 20));
  await page.mouse.down();
  await call(request, "kalamo_node_delete", { docId, nodeIds: [q] });
  await expect(page.getByRole("alert")).toContainText("the connection was not made");
  await page.mouse.move(...at(150, 30), { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await paths()).toEqual([]);
  await page.keyboard.press("Enter");
  await expect.poll(paths).toEqual(["M 20 80 L 60 80"]);
  expect(errors).toEqual([]);
});

// #292: a reconnect that keeps the Pen's continuation keeps drawing what it drew on the path.
test("a reconnect keeps the Pen continuation drawn", async ({ page, request }) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Pen reconnect",
      artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
    })
  ).structuredContent;
  const created = await call(request, "kalamo_node_create", {
    docId,
    nodes: [
      {
        type: "path",
        parentId,
        d: "M 20 20 L 60 20",
        appearance: { fills: [], strokes: [{ color: "#FF0000", width: 6 }] },
      },
    ],
  });
  const [a] = created.structuredContent.createdIds as [string];
  const d = async () =>
    (await call(request, "kalamo_node_get", { docId, nodeIds: [a], detail: "full" }))
      .structuredContent?.nodes[0]?.d;
  let sockets = 0;
  let close = () => {};
  await page.routeWebSocket(/\/ws$/, (ws) => {
    sockets += 1;
    ws.connectToServer();
    close = () => ws.close();
  });

  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;

  await page.keyboard.press("p");
  await page.mouse.click(...at(60, 20));
  await page.mouse.click(...at(100, 60));
  // The new segment's middle, painted in the path's Stroke.
  await expect.poll(() => pixel(page, 80, 40)).toEqual([255, 0, 0]);
  close();
  await expect.poll(() => sockets).toBe(2);
  await expect(page.getByTestId("status-bar")).not.toContainText("connecting");
  await page.waitForTimeout(100);
  expect(await pixel(page, 80, 40)).toEqual([255, 0, 0]);
  await page.keyboard.press("Enter");
  await expect.poll(d).toBe("M 20 20 L 60 20 L 100 60");
});
