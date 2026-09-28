import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { RED_2x2_PNG, WEBP_HEADER } from "../../../fixtures/images.ts";
import { call } from "./mcp.ts";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="10"/></svg>';

/** A 200 × 100 Document open in the page; the viewer fits its Artboard to the page's centre. */
async function open(page: Page, request: APIRequestContext) {
  const { docId, defaultLayerId } = (
    await call(request, "zibel_doc_create", {
      name: "E2E",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  await page.goto(`/docs/${docId}`);
  await expect(page.locator("body")).toContainText(/\d+%/);
  return { docId, defaultLayerId };
}

/** The Layer's children, with their bounds. */
const children = async (request: APIRequestContext, docId: string, layerId: string) =>
  (await call(request, "zibel_doc_outline", { docId, rootId: layerId, depth: 1 })).structuredContent
    .nodes as { id: string; name: string; type: string; bounds: { x: number; y: number } }[];

/** Pans right by 20 pt, so the viewport centre is (80, 50), no longer the Artboard's. */
async function pan(page: Page) {
  const scale = Number((await page.locator("body").innerText()).match(/(\d+)%/)?.[1]) / 100;
  const size = page.viewportSize() ?? { width: 0, height: 0 };
  const [cx, cy] = [size.width / 2, size.height / 2];
  await page.keyboard.down("Space");
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 20 * scale, cy, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Space");
}

/** A paste of `text` as plain text, as a keyboard Paste delivers it. */
const pasteText = (page: Page, text: string) =>
  page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  }, text);

test("pasting SVG text places it as a Group centred in the viewport, as the user", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId } = await open(page, request);
  await pan(page);

  await pasteText(page, SVG);

  await expect.poll(async () => (await children(request, docId, defaultLayerId)).length).toBe(1);
  const [group] = await children(request, docId, defaultLayerId);
  expect(group?.type).toBe("group");
  // Centred on (80, 50): the Artboard's centre, less the pan. Zoom text rounds the scale.
  expect(group?.bounds.x).toBeCloseTo(70, 0);
  expect(group?.bounds.y).toBeCloseTo(45, 1);
  const { changes } = (await call(request, "zibel_doc_changes", { docId, sinceRev: 1 }))
    .structuredContent;
  expect(changes).toMatchObject([
    { actor: "user", createdIds: expect.arrayContaining([group?.id]) },
  ]);
});

test("dropping an .svg file on the canvas places it, named after the file", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId } = await open(page, request);
  await page.getByTestId("overlay").evaluate((canvas, text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], "Logo.svg", { type: "image/svg+xml" }));
    canvas.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true }));
  }, SVG);

  await expect.poll(async () => (await children(request, docId, defaultLayerId)).length).toBe(1);
  const [group] = await children(request, docId, defaultLayerId);
  expect(group).toMatchObject({ type: "group", name: "Logo", bounds: { x: 90, y: 45 } });
});

test("pasting a PNG places an Image at its pixel size centred in the viewport, as the user", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId } = await open(page, request);
  await pan(page);

  // The File is built in the page: e2e has no Node Buffer.
  await page.evaluate((url) => {
    const bytes = Uint8Array.from(atob(url.split(",")[1] ?? ""), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "image.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  }, RED_2x2_PNG);

  await expect.poll(async () => (await children(request, docId, defaultLayerId)).length).toBe(1);
  const [image] = await children(request, docId, defaultLayerId);
  expect(image?.type).toBe("image");
  // Centred on (80, 50). Zoom text rounds the scale.
  expect(image?.bounds.x).toBeCloseTo(79, 0);
  expect(image?.bounds.y).toBeCloseTo(49, 1);
  const { changes } = (await call(request, "zibel_doc_changes", { docId, sinceRev: 1 }))
    .structuredContent;
  expect(changes).toMatchObject([{ actor: "user", createdIds: [image?.id] }]);
});

test("dropping a PNG places an Image; a WebP shows the Worker's hint and places nothing", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId } = await open(page, request);
  const drop = (url: string, name: string, type: string) =>
    page.getByTestId("overlay").evaluate(
      (canvas, [url = "", name = "", type]) => {
        const bytes = Uint8Array.from(atob(url.split(",")[1] ?? ""), (c) => c.charCodeAt(0));
        const data = new DataTransfer();
        data.items.add(new File([bytes], name, { type }));
        canvas.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true }));
      },
      [url, name, type],
    );

  await drop(RED_2x2_PNG, "Red.png", "image/png");
  await expect.poll(async () => (await children(request, docId, defaultLayerId)).length).toBe(1);
  const [image] = await children(request, docId, defaultLayerId);
  expect(image).toMatchObject({ type: "image", bounds: { x: 99, y: 49 } });

  await drop(WEBP_HEADER, "photo.webp", "image/webp");
  await expect(page.locator("body")).toContainText("Convert the image to PNG");
  expect(await children(request, docId, defaultLayerId)).toHaveLength(1);
});

// #136: with a leaf isolated, only a Place the Worker accepts goes up one level (ADR-0058).
test("a refused paste leaves an isolated leaf isolated; an accepted one goes up and selects it", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId } = await open(page, request);
  await call(request, "zibel_node_create", {
    docId,
    nodes: [
      {
        type: "rect",
        parentId: defaultLayerId,
        name: "Red",
        x: 20,
        y: 20,
        width: 160,
        height: 60,
        appearance: { fills: [{ color: "#FF0000" }], strokes: [] },
      },
    ],
  });
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  const bar = page.getByRole("navigation", { name: "Isolation Mode" });
  await expect(bar.locator("[aria-current=location]")).toContainText("Red");
  await pasteText(page, "<svg");
  await expect(page.locator("body")).toContainText("Could not place the pasted SVG");
  await expect(bar.locator("[aria-current=location]")).toContainText("Red");
  expect(await children(request, docId, defaultLayerId)).toHaveLength(1);

  await pasteText(page, SVG);
  await expect(bar).toBeHidden();
  await expect.poll(async () => (await children(request, docId, defaultLayerId)).length).toBe(2);
  const [, group] = await children(request, docId, defaultLayerId);
  await expect(page.getByRole("button", { name: group?.name, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
