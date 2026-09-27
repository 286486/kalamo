import { expect, test } from "@playwright/test";
import { BLUE_1x1_PNG } from "../../../fixtures/images.ts";
import { call } from "./mcp.ts";
import { choose } from "./menubar.ts";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><image href="photos/gone.png" x="10" y="10" width="40" height="20"/></svg>';

test("Relink fills a missing link from a file, then Embed embeds it, each as one user step", async ({
  page,
  request,
}) => {
  const { docId } = await (await request.post("/api/docs?name=linked.svg", { data: SVG })).json();
  const [layer] = (await call(request, "zibel_doc_outline", { docId, depth: 2 })).structuredContent
    .nodes as { id: string }[];
  const [image] = (await call(request, "zibel_doc_outline", { docId, rootId: layer?.id, depth: 1 }))
    .structuredContent.nodes as { id: string }[];
  const node = async () =>
    (await call(request, "zibel_node_get", { docId, nodeIds: [image?.id], detail: "full" }))
      .structuredContent.nodes[0];
  expect(await node()).not.toHaveProperty("src");

  await page.goto(`/docs/${docId}`);
  await expect(page.locator("body")).toContainText(/\d+%/);
  const row = page.getByRole("button", { name: "<Linked File>", exact: true });
  await row.click();
  const item = (name: string) => page.getByRole("menuitem", { name, exact: true });
  await page.getByRole("menuitem", { name: "Object", exact: true }).click();
  // A missing link has no pixels to Embed.
  await expect(item("Embed")).toBeDisabled();
  await expect(item("Relink…")).toBeEnabled();

  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), item("Relink…").click()]);
  // The File is built in the page: e2e has no Node Buffer.
  await (await chooser.element()).evaluate((input: HTMLInputElement, url) => {
    const bytes = Uint8Array.from(atob(url.split(",")[1] ?? ""), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "blue.png", { type: "image/png" }));
    input.files = data.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, BLUE_1x1_PNG);
  await expect
    .poll(node)
    .toMatchObject({ file: "blue.png", src: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(await node()).toMatchObject({ x: 10, y: 10, width: 40, height: 20 });

  await choose(page, "Object", "Embed");
  await expect.poll(async () => Object.hasOwn(await node(), "file")).toBe(false);
  await expect(page.getByRole("button", { name: "<Image>", exact: true })).toBeVisible();
  const { changes } = (await call(request, "zibel_doc_changes", { docId, sinceRev: 1 }))
    .structuredContent;
  expect(changes).toMatchObject([
    { actor: "user", summary: expect.stringContaining("Relink"), updatedIds: [image?.id] },
    { actor: "user", summary: expect.stringContaining("Embed"), updatedIds: [image?.id] },
  ]);
});
