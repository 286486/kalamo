import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";
import { choose } from "./menubar.ts";

test("a Template Layer draws on the canvas, shows the template glyph, and Export As SVG leaves it out (ADR-0099)", async ({
  page,
  request,
}) => {
  const { docId } = (
    await call(request, "kalamo_doc_create", {
      name: "E2E",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  const { keyMap } = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [{ type: "layer", name: "Reference", clientKey: "layer" }],
    })
  ).structuredContent;
  const layerId = keyMap.layer;
  const [boxId] = (
    await call(request, "kalamo_node_create", {
      docId,
      nodes: [
        {
          type: "rect",
          name: "Box",
          parentId: layerId,
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          appearance: { fills: [{ color: "#FF0000" }] },
        },
      ],
    })
  ).structuredContent.createdIds;
  await page.goto(`/docs/${docId}`);
  await expect(page.locator("body")).toContainText(/\d+%/);
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const glyph = (name: string) => button(name).locator("svg").getAttribute("data-testid");
  await expect.poll(() => glyph("Hide Reference")).toBe("eye-glyph");

  // An Agent makes it a Template Layer.
  await call(request, "kalamo_node_update", {
    docId,
    updates: [{ nodeId: layerId, patch: { template: true } }],
  });
  await expect.poll(() => glyph("Hide Reference")).toBe("template-glyph");
  if (await button("Expand Reference").isVisible()) await button("Expand Reference").click();
  await expect.poll(() => glyph("Hide Box")).toBe("eye-glyph");

  // The Artboard is fitted to the canvas, so the rect covers the canvas's centre.
  const centre = () =>
    page.getByTestId("canvas").evaluate((el: HTMLCanvasElement) => {
      const pixel = el.getContext("2d")?.getImageData(el.width / 2, el.height / 2, 1, 1).data;
      return Array.from(pixel ?? []);
    });
  await expect.poll(centre).toEqual([255, 0, 0, 255]);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    choose(page, "File", "Export", "Export As SVG"),
  ]);
  let text = "";
  for await (const chunk of await download.createReadStream()) text += chunk;
  expect(text).toContain("<svg");
  expect(text).not.toContain(layerId);
  expect(text).not.toContain(boxId);

  // The template glyph toggles visible as the eye does: blank when hidden.
  await button("Hide Reference").click();
  await expect(button("Show Reference").locator("svg")).toHaveCount(0);
  await button("Show Reference").click();
  await expect.poll(() => glyph("Hide Reference")).toBe("template-glyph");
});
