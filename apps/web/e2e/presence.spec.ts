import { type Browser, expect, type Page, test } from "@playwright/test";
import { call } from "./mcp.ts";

/** colorOf("user_alice"), which presence.test.ts pins. */
const ALICE: [number, number, number] = [0xf0, 0x8c, 0x00];

/** A browser whose dev-mode User is `name` (ADR-0090). */
async function as(browser: Browser, name: string) {
  const baseURL = test.info().project.use.baseURL as string;
  const context = await browser.newContext({ baseURL });
  await context.addCookies([{ name: "kalamo_dev_user", value: name, url: baseURL }]);
  return { context, page: await context.newPage() };
}

/** The page point of Artboard point (x, y) on a 200 × 100 Artboard centred at `scale`. */
async function at(page: Page, scale: number, x: number, y: number): Promise<[number, number]> {
  const box = await page.getByTestId("overlay").boundingBox();
  if (!box) throw new Error("no overlay");
  return [box.x + box.width / 2 + (x - 100) * scale, box.y + box.height / 2 + (y - 50) * scale];
}

/** Whether the overlay has a pixel within `r` px of page point (x, y) in `color`. */
const shows = (page: Page, [x, y]: [number, number], color: number[], r = 2) =>
  page.getByTestId("overlay").evaluate(
    (el: HTMLCanvasElement, [px, py, r, color]: [number, number, number, number[]]) => {
      const box = el.getBoundingClientRect();
      const k = el.width / box.width;
      const size = Math.ceil((2 * r + 1) * k);
      const left = Math.round((px - box.left - r) * k);
      const top = Math.round((py - box.top - r) * k);
      const data = el.getContext("2d")?.getImageData(left, top, size, size).data ?? [];
      for (let i = 0; i < data.length; i += 4) {
        const near = color.every((c, j) => Math.abs((data[i + j] ?? 0) - c) < 40);
        if (near && (data[i + 3] ?? 0) > 64) return true;
      }
      return false;
    },
    [x, y, r, color] as [number, number, number, number[]],
  );

test("each browser draws the other's labelled cursor and Selection, in document coordinates", async ({
  browser,
  request,
}) => {
  const create = async (name: string) =>
    (await call(request, "kalamo_doc_create", { name, artboards: [{ width: 200, height: 100 }] }))
      .structuredContent as { docId: string; defaultLayerId: string };
  const { docId, defaultLayerId } = await create("Presence");
  await call(request, "kalamo_node_create", {
    docId,
    nodes: [
      { type: "rect", parentId: defaultLayerId, name: "Box", x: 50, y: 25, width: 40, height: 20 },
    ],
  });
  const { docId: other } = await create("Presence other");

  const alice = await as(browser, "alice");
  const bob = await as(browser, "bob");
  // Alice's socket, which the test closes to make it reconnect.
  const sockets: { close: () => Promise<void> }[] = [];
  await alice.page.routeWebSocket(/\/ws$/, (ws) => {
    ws.connectToServer();
    sockets.push(ws);
  });
  for (const { page } of [alice, bob]) {
    await page.goto(`/docs/${docId}`);
    await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  }
  // Alice at 100%; Bob at Fit Artboard in Window.
  await alice.page.keyboard.press("Control+1");
  await expect(alice.page.getByTestId("status-bar")).toContainText("100%");
  const box = await bob.page.getByTestId("overlay").boundingBox();
  if (!box) throw new Error("no overlay");
  const fitted = Math.min((box.width - 40) / 200, (box.height - 40) / 100);
  expect(fitted).toBeGreaterThan(2);

  // The cursor: an arrow at the same Artboard point, with its label pill below right.
  await alice.page.mouse.move(...(await at(alice.page, 1, 20, 70)));
  const [cx, cy] = await at(bob.page, fitted, 20, 70);
  await expect.poll(() => shows(bob.page, [cx + 2, cy + 6], ALICE, 1)).toBe(true);
  await expect.poll(() => shows(bob.page, [cx + 10, cy + 20], ALICE, 1)).toBe(true);

  // The Selection: Box's bounds, outlined in Alice's colour.
  const edge = async () => shows(bob.page, await at(bob.page, fitted, 70, 25), ALICE);
  await alice.page.getByRole("button", { name: "Box", exact: true }).click();
  await expect.poll(edge).toBe(true);

  // A reconnect sends the Selection again, though it has not changed.
  await sockets[0]?.close();
  await expect.poll(() => sockets.length).toBe(2);
  await expect(alice.page.getByTestId("status-bar")).not.toContainText("connecting");
  await expect.poll(edge).toBe(true);

  // So does switching tabs away and back: the other tab's socket leaves, then a new one joins.
  // Going through the Documents list reloads the page, which forgets the Selection.
  await alice.page.goto("/");
  await alice.page.locator(`a[href="/docs/${other}"]`).click();
  const tab = (name: string) => alice.page.getByRole("tab", { name, exact: true });
  await expect(tab("Presence other")).toHaveAttribute("aria-selected", "true");
  await expect.poll(edge).toBe(false);
  await tab("Presence").click();
  await alice.page.getByRole("button", { name: "Box", exact: true }).click();
  await expect.poll(edge).toBe(true);
  await tab("Presence other").click();
  await expect.poll(edge).toBe(false);
  await tab("Presence").click();
  await expect.poll(edge).toBe(true);

  // Closing Alice's browser takes her cursor and Selection away. The reload fitted her view.
  await alice.page.keyboard.press("Control+1");
  await expect(alice.page.getByTestId("status-bar")).toContainText("100%");
  await alice.page.mouse.move(...(await at(alice.page, 1, 20, 70)));
  await expect.poll(() => shows(bob.page, [cx + 2, cy + 6], ALICE, 1)).toBe(true);
  await alice.context.close();
  await expect.poll(() => shows(bob.page, [cx + 2, cy + 6], ALICE, 1)).toBe(false);
  await expect.poll(edge).toBe(false);
  await bob.context.close();
});
