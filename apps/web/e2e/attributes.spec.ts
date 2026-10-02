import { expect, test } from "@playwright/test";
import { call } from "./mcp.ts";

// #270: Window > Attributes sets a Compound Path's fill rule and the direction of a subpath chosen
// with Direct Selection, each one undo step (ADR-0108).

/** Each subpath of `d` clockwise on screen, by the signed area of its Anchors. */
function clockwise(d: string): boolean[] {
  return d
    .split("M")
    .filter((s) => s.trim())
    .map((s) => {
      // Each segment's end point is its last two numbers.
      const ends = s.split(/[LCZ]/).flatMap((seg) => {
        const n = seg.trim().split(/\s+/).filter(Boolean).map(Number);
        return n.length >= 2 ? [n.slice(-2) as [number, number]] : [];
      });
      let area = 0;
      for (const [i, [x1, y1]] of ends.entries()) {
        const [x2, y2] = ends[(i + 1) % ends.length] as [number, number];
        area += x1 * y2 - x2 * y1;
      }
      return area > 0;
    });
}

test("Ctrl+F11's Attributes panel makes and removes a ring's hole by direction and fill rule, one undo step each", async ({
  page,
  request,
}) => {
  const { docId, defaultLayerId: parentId } = (
    await call(request, "kalamo_doc_create", {
      name: "Attributes",
      artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
    })
  ).structuredContent;
  const circle = (r: number) => ({
    ...{ type: "ellipse", parentId, x: 100 - r, y: 50 - r, width: 2 * r, height: 2 * r },
    appearance: { fills: [{ color: "#FF0000" }] },
  });
  await call(request, "kalamo_node_create", { docId, nodes: [circle(40), circle(15)] });
  await page.goto(`/docs/${docId}`);
  await expect(page.getByTestId("status-bar")).toContainText(/\d+%/);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("status-bar")).toContainText("100%");
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x - 100, box.y + box.height / 2 + y - 50] as const;

  // The centre, in the inner circle, then the ring at x 70.
  const colors = () =>
    page.getByTestId("canvas").evaluate((el: HTMLCanvasElement) => {
      const k = el.width / el.getBoundingClientRect().width;
      const ctx = el.getContext("2d");
      return [100, 70].map((x) => {
        const [px, py] = [(el.width / k / 2 + x - 100) * k, (el.height / k / 2) * k];
        const [r = 0, g = 0, b = 0] = ctx?.getImageData(px, py, 1, 1).data ?? [];
        return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
      });
    });
  const HOLE = ["#FFFFFF", "#FF0000"];
  const FILLED = ["#FF0000", "#FF0000"];

  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+8");
  await expect(page.getByRole("button", { name: "<Compound Path>", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const { nodes } = (await call(request, "kalamo_doc_outline", { docId, depth: 9 }))
    .structuredContent;
  const ring = nodes[0].children[0].id as string;
  const stored = async () => {
    const n = (await call(request, "kalamo_node_get", { docId, nodeIds: [ring], detail: "full" }))
      .structuredContent.nodes[0];
    return { fillRule: n.fillRule ?? "nonzero", clockwise: clockwise(n.d) };
  };
  await expect.poll(colors).toEqual(HOLE);

  // Ctrl+F11 shows the panel, checked under Window; Window > Attributes hides it again.
  const panel = page.getByRole("region", { name: "Attributes" });
  const button = (name: string) => panel.getByRole("button", { name, exact: true });
  await expect(panel).toBeHidden();
  await page.keyboard.press("Control+F11");
  await expect(panel).toBeVisible();
  const item = page.getByRole("menuitemcheckbox", { name: "Attributes" });
  await page.getByRole("menuitem", { name: "Window", exact: true }).click();
  await expect(item).toHaveAttribute("aria-checked", "true");
  await item.click();
  await expect(panel).toBeHidden();
  await page.keyboard.press("Control+F11");
  await expect(panel).toBeVisible();

  // The Compound Path selected: its rule shows, and Reverse Path Direction needs Direct Selection.
  await expect(button("Use Non-Zero Winding Fill Rule")).toHaveAttribute("aria-pressed", "true");
  await expect(button("Use Even-Odd Fill Rule")).toHaveAttribute("aria-pressed", "false");
  await expect(button("Reverse Path Direction Off")).toBeDisabled();
  await expect(button("Reverse Path Direction On")).toBeDisabled();
  expect(await stored()).toEqual({ fillRule: "nonzero", clockwise: [false, true] });

  // The inner circle's Anchor at (115, 50), chosen with Direct Selection, is a hole: On.
  await page.keyboard.press("a");
  await page.mouse.click(...at(115, 50));
  await expect(button("Reverse Path Direction On")).toHaveAttribute("aria-pressed", "true");
  await button("Reverse Path Direction Off").click();
  await expect(button("Reverse Path Direction Off")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(stored).toEqual({ fillRule: "nonzero", clockwise: [false, false] });
  await expect.poll(colors).toEqual(FILLED);
  await button("Reverse Path Direction On").click();
  await expect.poll(stored).toEqual({ fillRule: "nonzero", clockwise: [false, true] });
  await expect.poll(colors).toEqual(HOLE);
  await button("Reverse Path Direction Off").click();
  await expect.poll(stored).toEqual({ fillRule: "nonzero", clockwise: [false, false] });
  await expect.poll(colors).toEqual(FILLED);

  // The whole Compound Path under Even-Odd: the hole is back whatever the directions.
  await page.keyboard.press("v");
  await page.mouse.click(...at(70, 50));
  await expect(button("Reverse Path Direction Off")).toBeDisabled();
  await button("Use Even-Odd Fill Rule").click();
  await expect(button("Use Even-Odd Fill Rule")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(stored).toEqual({ fillRule: "evenodd", clockwise: [false, false] });
  await expect.poll(colors).toEqual(HOLE);
  // Pressing the rule it has sends nothing, so the next Undo takes back Even-Odd.
  await button("Use Even-Odd Fill Rule").click();

  await page.keyboard.press("Control+Z");
  await expect.poll(stored).toEqual({ fillRule: "nonzero", clockwise: [false, false] });
  await expect.poll(colors).toEqual(FILLED);
  await page.keyboard.press("Control+Z");
  await expect.poll(stored).toEqual({ fillRule: "nonzero", clockwise: [false, true] });
  await expect.poll(colors).toEqual(HOLE);

  // Nothing selected: every control is disabled.
  await page.keyboard.press("Shift+Control+A");
  for (const name of [
    "Use Non-Zero Winding Fill Rule",
    "Use Even-Odd Fill Rule",
    "Reverse Path Direction Off",
    "Reverse Path Direction On",
  ]) {
    await expect(button(name)).toBeDisabled();
  }
});
