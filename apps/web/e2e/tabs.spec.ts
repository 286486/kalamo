import { expect, type Page, test } from "@playwright/test";
import { LEGACY_NAME } from "../../../packages/core/src/legacy.ts";
import { call } from "./mcp.ts";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="10"/></svg>';

const tabs = (page: Page) => page.getByRole("tab");
const zoom = async (page: Page) => (await page.locator("body").innerText()).match(/(\d+)%/)?.[1];

test("Documents open in tabs that switch in place, close, and come back on reload", async ({
  page,
  request,
}) => {
  const create = async (name: string) =>
    (await call(request, "kalamo_doc_create", { name, artboards: [{ width: 200, height: 100 }] }))
      .structuredContent as { docId: string; defaultLayerId: string };
  const { docId: a, defaultLayerId } = await create("Tab A");
  await call(request, "kalamo_node_create", {
    docId: a,
    nodes: [
      { type: "rect", parentId: defaultLayerId, name: "Box", x: 0, y: 0, width: 10, height: 10 },
    ],
  });
  const { docId: b } = await create("Tab B");

  await page.goto(`/docs/${a}`);
  await expect(tabs(page)).toHaveText(["Tab A"]);
  await page.goto("/");
  // The e2e state outlives a run, so the list may hold an earlier "Tab B".
  await page.locator(`a[href="/docs/${b}"]`).click();
  await expect(tabs(page)).toHaveText(["Tab A", "Tab B"]);
  await expect(page.getByRole("tab", { name: "Tab B" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("body")).toContainText(/\d+%/);
  const fitted = await zoom(page);

  // Tab A keeps its viewport and Selection while Tab B is shown.
  await page.getByRole("tab", { name: "Tab A" }).click();
  await expect(page).toHaveURL(`/docs/${a}`);
  await expect(page.locator("body")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.locator("body")).toContainText("100%");
  const box = page.getByRole("button", { name: "Box", exact: true });
  await box.click();
  await expect(box).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("tab", { name: "Tab B" }).click();
  await expect(page.locator("body")).toContainText(`${fitted}%`);
  await page.getByRole("tab", { name: "Tab A" }).click();
  await expect(page.locator("body")).toContainText("100%");
  await expect(box).toHaveAttribute("aria-pressed", "true");

  // Open file… makes a new Document in a new, active tab.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Open file…" }).click(),
  ]);
  await (await chooser.element()).evaluate((input: HTMLInputElement, text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], "opened.svg", { type: "image/svg+xml" }));
    input.files = data.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, SVG);
  await expect(tabs(page)).toHaveText(["Tab A", "Tab B", "opened"]);
  await expect(page.getByRole("tab", { name: "opened" })).toHaveAttribute("aria-selected", "true");

  // A file dropped on the tab bar Opens too.
  await page.getByRole("tablist").evaluate((bar, text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], "dropped.svg", { type: "image/svg+xml" }));
    bar.dispatchEvent(
      new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }),
    );
  }, SVG);
  await expect(tabs(page)).toHaveText(["Tab A", "Tab B", "opened", "dropped"]);

  // Closing a tab closes the view only.
  await page.getByRole("button", { name: "Close Tab B" }).click();
  await page.getByRole("button", { name: "Close dropped" }).click();
  await expect(tabs(page)).toHaveText(["Tab A", "opened"]);
  await expect(page.getByRole("tab", { name: "opened" })).toHaveAttribute("aria-selected", "true");
  const { documents } = await (await request.get("/api/docs")).json();
  expect(documents.map((d: { docId: string }) => d.docId)).toContain(b);

  // A remembered tab whose Document is gone drops on reload.
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("kalamo:tabs") ?? "[]");
    localStorage.setItem("kalamo:tabs", JSON.stringify([...stored, "gone"]));
  });
  await page.reload();
  await expect(tabs(page)).toHaveText(["Tab A", "opened"]);
  await expect(page.getByRole("tab", { name: "opened" })).toHaveAttribute("aria-selected", "true");

  // Tabs remembered under the former name's key come back once, then live under Kalamo's
  // (ADR-0069).
  await page.evaluate((legacy) => {
    localStorage.setItem(`${legacy}:tabs`, localStorage.getItem("kalamo:tabs") ?? "");
    localStorage.removeItem("kalamo:tabs");
  }, LEGACY_NAME);
  await page.reload();
  await expect(tabs(page)).toHaveText(["Tab A", "opened"]);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(["kalamo:tabs"]);
});
