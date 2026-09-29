import { createDocument, createNodes } from "@kalamo/core";
import { expect, it } from "vitest";
import { fit, renderSvg } from "./svg.ts";

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { data?: unknown }).data;
  }
  throw new Error("did not throw");
};

it("fits a rect to whole pixels, lowering the scale to maxSize and refusing more than 4096 px", () => {
  const rect = (width: number, height: number) => ({ x: 0, y: 0, width, height });
  expect(fit(rect(200, 100), 2)).toEqual({
    rect: rect(200, 100),
    scale: 2,
    pixelSize: { width: 400, height: 200 },
  });
  expect(fit(rect(2000, 100), 1, 1600)).toEqual({
    rect: rect(2000, 100),
    scale: 0.8,
    pixelSize: { width: 1600, height: 80 },
  });
  // Widened to whole pixels, since resvg stretches the drawing to its rounded size.
  expect(fit(rect(10.2, 10), 2)).toEqual({
    rect: rect(10.5, 10),
    scale: 2,
    pixelSize: { width: 21, height: 20 },
  });
  expect(errorOf(() => fit(rect(2000, 100), 4, 8000))).toMatchObject({
    code: "LIMIT_EXCEEDED",
    path: "maxSize",
    hint: expect.stringContaining("4096"),
  });
  expect(errorOf(() => fit(rect(2000, 100), 4))).toMatchObject({
    code: "LIMIT_EXCEEDED",
    path: "scale",
    hint: expect.stringContaining("scale <= 2.04"),
  });
});

/** A Layer holding Group A (rect, line) and rect B, on a white Artboard. */
function scene() {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
  });
  // Inline children follow their Group: [Group A, its rect, its line, rect B].
  const [a, inA, lineInA, b] = createNodes(doc, [
    {
      type: "group",
      parentId,
      children: [
        {
          type: "rect",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          appearance: { fills: [{ color: "#AA0000" }] },
        },
        {
          type: "line",
          x1: 0,
          y1: 0,
          x2: 5,
          y2: 5,
          appearance: { strokes: [{ color: "#00AA00" }] },
        },
      ],
    },
    {
      type: "rect",
      parentId,
      x: 50,
      y: 50,
      width: 10,
      height: 10,
      appearance: { fills: [{ color: "#0000AA" }] },
    },
  ]).nodes;
  if (!a || !b || !inA || !lineInA) throw new Error("setup");
  return { doc, a, b, inA, lineInA };
}

it("labels every drawn Node but Layers with its id and bounds, sized in pixels", () => {
  const { doc, a, b, inA, lineInA } = scene();
  const layer = doc.nodes.get(a.parentId ?? "");
  if (!layer) throw new Error("setup");
  const svg = renderSvg(doc, undefined, { overlays: ["ids", "bounds"], scale: 2 });
  for (const n of [a, b, inA, lineInA]) {
    expect(svg).toContain(`>${n.id}</text>`);
  }
  expect(svg).not.toContain(`>${layer.id}</text>`);
  expect(svg).toContain('font-size="5.5"');
  expect(svg).toContain(
    '<rect x="50" y="50" width="10" height="10" fill="none" stroke="#FF00FF" stroke-width="0.5"/>',
  );
  // Four boxes, none for the Layer; overlays come after the artwork.
  expect(svg.match(/stroke="#FF00FF" stroke-width="0.5"\/>/g)).toHaveLength(4);
  expect(svg.indexOf("#FF00FF")).toBeGreaterThan(svg.indexOf("#0000AA"));
  expect(renderSvg(doc)).not.toContain("#FF00FF");
});

it("gives hidden Nodes and Nodes outside the scope no overlay, and outlines Artboards", () => {
  const { doc, a, b, inA } = scene();
  inA.visible = false;
  const svg = renderSvg(doc, undefined, {
    scope: { nodeIds: [a.id] },
    overlays: ["ids", "artboards"],
    scale: 4,
  });
  expect(svg).toContain(`>${a.id}</text>`);
  // The hidden Node is written but has no label; b is outside the scope and not written.
  expect(svg).toContain(`id="z-${inA.id}"`);
  expect(svg).not.toContain(`>${inA.id}</text>`);
  expect(svg).not.toContain(b.id);
  expect(svg).toContain(
    '<rect x="0" y="0" width="200" height="100" fill="none" stroke="#00AEEF" stroke-width="0.25"/>',
  ); // Nothing drawn, nothing appended.
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  expect(renderSvg(doc, rect, { scope: { nodeIds: [inA.id] }, overlays: ["ids"] })).toMatch(
    /<\/g><\/g><\/svg>$/,
  );
});
