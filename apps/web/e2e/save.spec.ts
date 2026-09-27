import { expect, test } from "@playwright/test";
import { RED_2x2_PNG } from "../../../fixtures/images.ts";
import { call } from "./mcp.ts";
import { choose } from "./menubar.ts";

test("File > Save a Copy… saves the .zibel.json that export returns and doc_open accepts", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId } = (
    await call(request, "zibel_doc_create", {
      name: "E2E",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  await call(request, "zibel_node_create", {
    docId,
    nodes: [{ type: "rect", parentId: defaultLayerId, x: 75, y: 25, width: 50, height: 50 }],
  });

  await page.goto(`/docs/${docId}`);
  await expect(page.locator("body")).toContainText(/\d+%/);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    choose(page, "File", "Save a Copy…"),
  ]);
  expect(download.suggestedFilename()).toBe("E2E.zibel.json");
  let text = "";
  for await (const chunk of await download.createReadStream()) text += chunk;
  const exported = await call(request, "zibel_export", { docId, format: "zibel_json" });
  expect(text).toBe(exported.content[0].text);

  const opened = await call(request, "zibel_doc_open", { content: text });
  expect(opened.structuredContent).toMatchObject({ name: "E2E", rev: 1 });
});

test("File > Export > Export As SVG saves the Inkscape SVG that export returns at that rev", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId } = (
    await call(request, "zibel_doc_create", {
      name: "E2E",
      artboards: [
        { width: 200, height: 100 },
        { width: 50, height: 50, background: "#FFEEDD" },
      ],
    })
  ).structuredContent;
  await call(request, "zibel_node_create", {
    docId,
    nodes: [
      { type: "rect", parentId: defaultLayerId, x: 75, y: 25, width: 50, height: 50, radius: 5 },
      {
        type: "star",
        parentId: defaultLayerId,
        cx: 30,
        cy: 30,
        outerRadius: 20,
        innerRadius: 8,
        points: 5,
      },
      { type: "text", parentId: defaultLayerId, x: 10, y: 90, content: "Hi & bye" },
    ],
  });

  await page.goto(`/docs/${docId}`);
  await expect(page.locator("body")).toContainText(/\d+%/);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    choose(page, "File", "Export", "Export As SVG"),
  ]);
  expect(download.suggestedFilename()).toBe("E2E.svg");
  let text = "";
  for await (const chunk of await download.createReadStream()) text += chunk;
  const exported = await call(request, "zibel_export", { docId, format: "svg" });
  expect(text).toBe(exported.content[0].text);
});

test("the canvas draws an Image, and both downloads embed its file as export does", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId } = (
    await call(request, "zibel_doc_create", {
      name: "E2E",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  await call(request, "zibel_node_create", {
    docId,
    nodes: [
      {
        type: "image",
        parentId: defaultLayerId,
        src: RED_2x2_PNG,
        x: 75,
        y: 25,
        width: 50,
        height: 50,
      },
    ],
  });

  await page.goto(`/docs/${docId}`);
  await expect(page.locator("body")).toContainText(/\d+%/);
  // The Artboard is fitted to the canvas, so the Image covers the canvas's centre.
  const centre = () =>
    page.getByTestId("canvas").evaluate((el: HTMLCanvasElement) => {
      const pixel = el.getContext("2d")?.getImageData(el.width / 2, el.height / 2, 1, 1).data;
      return Array.from(pixel ?? []);
    });
  await expect.poll(centre).toEqual([255, 0, 0, 255]);

  for (const [path, format] of [
    [["File", "Export", "Export As SVG"], "svg"],
    [["File", "Save a Copy…"], "zibel_json"],
  ] as const) {
    const [download] = await Promise.all([page.waitForEvent("download"), choose(page, ...path)]);
    let text = "";
    for await (const chunk of await download.createReadStream()) text += chunk;
    const exported = await call(request, "zibel_export", { docId, format });
    expect(text).toBe(exported.content[0].text);
  }
});
