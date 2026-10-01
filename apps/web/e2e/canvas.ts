import type { Page } from "@playwright/test";

/** The page point of Artboard point (x, y) on a 200 × 100 Artboard centred at `scale`. */
export async function at(
  page: Page,
  scale: number,
  x: number,
  y: number,
): Promise<[number, number]> {
  const box = await page.getByTestId("overlay").boundingBox();
  if (!box) throw new Error("no overlay");
  return [box.x + box.width / 2 + (x - 100) * scale, box.y + box.height / 2 + (y - 50) * scale];
}

/** Whether the overlay has a pixel within `r` px of page point (x, y) in `color`. */
export const shows = (page: Page, [x, y]: [number, number], color: number[], r = 2) =>
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
