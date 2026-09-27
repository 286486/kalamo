import { expect, test } from "@playwright/test";
import { COMPOSITING, near } from "../../../fixtures/compositing.ts";
import { call } from "./mcp.ts";

interface Entry {
  id: string;
  name: string;
  children?: Entry[];
}

// #111, #105: the canvas composes a translucent or blended Node as one image (ADR-0044) and draws
// a container's Appearance (ADR-0043), as `render` does. The same cases are checked against resvg
// in the render package's PNG tests.
for (const c of COMPOSITING) {
  test(`the canvas matches render: ${c.name}`, async ({ page, request }) => {
    const { docId, defaultLayerId: parentId } = (
      await call(request, "zibel_doc_create", {
        name: "Compositing",
        artboards: [{ width: 200, height: 100 }],
      })
    ).structuredContent;
    await call(request, "zibel_node_create", {
      docId,
      nodes: c.nodes.map((n) => ({ ...n, parentId })),
    });
    const ids = new Map<string, string>([["Layer", parentId]]);
    const walk = (es: Entry[]) => {
      for (const e of es) {
        ids.set(e.name, e.id);
        walk(e.children ?? []);
      }
    };
    walk(
      (await call(request, "zibel_doc_outline", { docId, rootId: parentId, depth: 9 }))
        .structuredContent.nodes,
    );
    if (c.mask) {
      const { createdIds } = (
        await call(request, "zibel_mask_make", {
          docId,
          clipNodeId: ids.get(c.mask.clip),
          contentIds: c.mask.content.map((k) => ids.get(k)),
        })
      ).structuredContent;
      ids.set("mask", createdIds[0]);
    }
    await page.goto(`/docs/${docId}`);
    await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
    await page.keyboard.press("Control+1");
    await expect(page.getByTestId("status-bar")).toContainText("100%");
    // Patched once the canvas is open, so each case also reaches it through the broadcast.
    await call(request, "zibel_node_update", {
      docId,
      updates: Object.entries(c.patches).map(([k, patch]) => ({ nodeId: ids.get(k), patch })),
    });
    // At 100% the Artboard's centre, (100, 50), is the canvas's.
    const read = () =>
      page.getByTestId("canvas").evaluate((el: HTMLCanvasElement, probes) => {
        const k = el.width / el.getBoundingClientRect().width;
        const ctx = el.getContext("2d");
        return probes.map(({ x, y }) => {
          const [px, py] = [(el.width / k / 2 + x - 100) * k, (el.height / k / 2 + y - 50) * k];
          return [...(ctx?.getImageData(px, py, 1, 1).data ?? [])].slice(0, 3);
        });
      }, c.probes);
    const wrong = async () => {
      const got = await read();
      return c.probes.flatMap(({ x, y, rgb }, i) =>
        near(got[i] ?? [], rgb) ? [] : [`${x}, ${y}: ${got[i]} not ${rgb.map(Math.round)}`],
      );
    };
    await expect.poll(wrong).toEqual([]);
  });
}
