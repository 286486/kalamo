import { expect, test } from "@playwright/test";
import { at, shows } from "./canvas.ts";
import { call } from "./mcp.ts";

/** colorOf("agent-a"). */
const AGENT: [number, number, number] = [0xe8, 0x41, 0x3c];
const INTENT = "Draw the header box for the landing page, with room for the logo";

test("an Agent's write shows its dashed Working Area and intent until 5 minutes pass", async ({
  page,
  request,
}) => {
  // The texts the canvases draw, which pixels cannot show.
  await page.addInitScript(() => {
    const texts: string[] = [];
    Object.assign(window, { texts });
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      texts.push(text);
      return fillText.call(this, text, ...rest);
    };
  });
  await page.clock.install();
  const { docId, defaultLayerId } = (
    await call(request, "kalamo_doc_create", {
      name: "Working Area",
      artboards: [{ width: 200, height: 100 }],
    })
  ).structuredContent;
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  const box = await page.getByTestId("overlay").boundingBox();
  if (!box) throw new Error("no overlay");
  const fitted = Math.min((box.width - 40) / 200, (box.height - 40) / 100);

  const draw = (y: number) =>
    call(request, "kalamo_node_create", {
      docId,
      intent: INTENT,
      nodes: [{ type: "rect", parentId: defaultLayerId, x: 50, y, width: 40, height: 20 }],
    });
  const texts = () => page.evaluate(() => (window as unknown as { texts: string[] }).texts);
  await draw(40);
  // The area's left edge, dashed in the Agent's colour, and its pill's text, cut to 48 characters.
  const edge = async () => shows(page, await at(page, fitted, 50, 50), AGENT);
  await expect.poll(edge).toBe(true);
  expect(await texts()).toContain(`agent-a · ${INTENT.slice(0, 47)}…`);

  // With no message or input since, the area goes once 5 minutes have passed.
  await page.clock.fastForward("04:50");
  expect(await edge()).toBe(true);
  await page.clock.fastForward("00:10");
  await expect.poll(edge).toBe(false);

  // Hovering the pill shows the whole intent; a press on it still reaches the Selection Tool,
  // whose marquee from there selects the rectangle, which Delete then deletes.
  const { createdIds } = (await draw(40)).structuredContent;
  await expect.poll(edge).toBe(true);
  const [x, y] = await at(page, fitted, 50, 40);
  await page.mouse.move(x + 6, y - 8);
  await expect(page.getByRole("tooltip")).toHaveText(INTENT);
  await page.mouse.down();
  await page.mouse.move(x + 50 * fitted, y + 30 * fitted, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.keyboard.press("Delete");
  await expect
    .poll(
      async () => (await call(request, "kalamo_node_get", { docId, nodeIds: createdIds })).isError,
    )
    .toBe(true);
});
