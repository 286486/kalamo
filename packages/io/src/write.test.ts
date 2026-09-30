import {
  type Alignment,
  createDocument,
  createNodes,
  formatNumber,
  formatPath,
  glyphs,
  LEGACY_NAME,
  LEGACY_SVG_NS,
  layoutText,
  makeMask,
  type Node,
  type ShapeNode,
  serializeDocument,
  shapeSegments,
  type TextNode,
  updateNodes,
} from "@kalamo/core";
import { describe, expect, it } from "vitest";
import { parseSvg } from "./read.ts";
import { scopeRect, svgRect, toSvg } from "./write.ts";

const newDoc = () =>
  createDocument({ id: "d", name: "Doc", artboards: [{ width: 200, height: 100 }] });

it("writes a leaf with one Fill and one Stroke as one element", () => {
  const { doc, defaultLayerId } = newDoc();
  const [rect] = createNodes(doc, [
    {
      type: "rect",
      parentId: defaultLayerId,
      x: 10,
      y: 10,
      width: 50,
      height: 30,
      appearance: { fills: [{ color: "#FF0000" }], strokes: [{ color: "#000000", width: 2 }] },
    },
  ]).nodes;
  expect(toSvg(doc)).toContain(
    `<rect x="10" y="10" width="50" height="30" id="z-${rect?.id}" fill="#FF0000" stroke="#000000" stroke-width="2" stroke-miterlimit="10"/></g>`,
  );
});

it("writes rect, ellipse and line as their own elements, and other shapes as the d node_get returns", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const { nodes } = createNodes(doc, [
    {
      type: "group",
      parentId,
      children: [
        { type: "rect", x: 0, y: 0, width: 10, height: 10, radius: 2 },
        { type: "group", children: [{ type: "line", x1: 0, y1: 0, x2: 5, y2: 5 }] },
      ],
    },
    { type: "ellipse", parentId, x: 0, y: 0, width: 20, height: 10 },
    { type: "ellipse", parentId, x: 40, y: 0, width: 10, height: 10 },
    { type: "rect", parentId, x: 0, y: 0, width: 4, height: 10, radius: 5 },
    { type: "polygon", parentId, cx: 50, cy: 50, radius: 10, sides: 5 },
    { type: "star", parentId, cx: 80, cy: 50, outerRadius: 10, innerRadius: 4, points: 5 },
    { type: "path", parentId, d: "M 0 0 Q 10 20 20 0 Z" },
    { type: "layer" },
  ]);
  const svg = toSvg(doc);
  const paths = nodes.filter(
    (n): n is ShapeNode => n.type === "polygon" || n.type === "star" || n.type === "path",
  );
  expect(paths).toHaveLength(3);
  for (const n of paths) expect(svg).toContain(`d="${formatPath(shapeSegments(n))}"`);
  expect(svg).toContain('<rect x="0" y="0" width="10" height="10" rx="2" ry="2" id=');
  expect(svg).toContain(
    '<path sodipodi:type="star" sodipodi:sides="5" sodipodi:cx="50" sodipodi:cy="50" sodipodi:r1="10" sodipodi:r2="8.090169943749475" ' +
      'sodipodi:arg1="-1.5707963267948966" sodipodi:arg2="-0.9424777960769379" inkscape:flatsided="true" ' +
      'inkscape:rounded="0" inkscape:randomized="0" d="M 50 40 L 59.511 46.91 L 55.878 58.09',
  );
  expect(svg).toContain(
    '<path sodipodi:type="star" sodipodi:sides="5" sodipodi:cx="80" sodipodi:cy="50" sodipodi:r1="10" sodipodi:r2="4" ' +
      'sodipodi:arg1="-1.5707963267948966" sodipodi:arg2="-0.9424777960769379" inkscape:flatsided="false" ' +
      'inkscape:rounded="0" inkscape:randomized="0" d="M 80 40 L 82.351 46.764',
  );
  expect(svg).toContain('<line x1="0" y1="0" x2="5" y2="5" id=');
  expect(svg).toContain('<ellipse cx="10" cy="5" rx="10" ry="5" id=');
  expect(svg).toContain('<circle cx="45" cy="5" r="5" id=');
  // The radius is clamped to half the shorter side.
  expect(svg).toContain('<rect x="0" y="0" width="4" height="10" rx="2" ry="2" id=');
  // Layer 1 > Group > [rect, Group > line]; the second top-level Layer is empty.
  expect(svg).toMatch(/<g [^>]*inkscape:groupmode="layer"><g [^>]*><rect[^>]*\/><g [^>]*><line/);
  expect(svg).toMatch(/<g [^>]*inkscape:groupmode="layer"><\/g><\/svg>$/);
});

it("writes a star's Inkscape parameters as set, and its centre and radii at full precision", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const [star] = createNodes(doc, [
    {
      type: "star",
      parentId,
      cx: 80.1234567,
      cy: 50,
      outerRadius: 10.0001,
      innerRadius: 4,
      points: 5,
      angle: 30,
      twist: 10,
      rounded: 0.3,
      randomized: 0.1,
    },
  ]).nodes;
  if (star?.type !== "star") throw new Error("setup");
  const arg1 = -Math.PI / 2 + (30 * Math.PI) / 180;
  const arg2 = arg1 + Math.PI / 5 + (10 * Math.PI) / 180;
  const svg = toSvg(doc);
  expect(svg).toContain(
    `sodipodi:cx="80.1234567" sodipodi:cy="50" sodipodi:r1="10.0001" sodipodi:r2="4" sodipodi:arg1="${arg1}" sodipodi:arg2="${arg2}" ` +
      'inkscape:flatsided="false" inkscape:rounded="0.3" inkscape:randomized="0.1" d="M ',
  );
  expect(svg).toContain(`d="${formatPath(shapeSegments(star))}"`);
  expect(formatPath(shapeSegments(star))).toContain("C");
});

it("writes a spiral as an Inkscape spiral, its parameters at full precision (ADR-0060)", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const params = {
    cx: 80.1234567,
    cy: 50,
    radius: 30.0001,
    revolution: 2.75,
    expansion: 0.6,
    t0: 0.12345678,
  };
  const [spiral] = createNodes(doc, [{ type: "spiral", parentId, ...params, argument: 30 }]).nodes;
  if (spiral?.type !== "spiral") throw new Error("setup");
  const svg = toSvg(doc);
  expect(svg).toContain(
    'sodipodi:type="spiral" sodipodi:cx="80.1234567" sodipodi:cy="50" sodipodi:radius="30.0001" ' +
      `sodipodi:revolution="2.75" sodipodi:expansion="0.6" sodipodi:argument="${Math.PI / 6}" sodipodi:t0="0.12345678" d="M `,
  );
  expect(svg).toContain(`d="${formatPath(shapeSegments(spiral))}"`);
  const [back] = parseSvg(svg).nodes.filter((n) => n.type === "spiral");
  expect(back).toMatchObject({ ...params, cx: 80.123, radius: 30, argument: 30 });
});

it("writes a cut ellipse, or a whole one with other parameters, as an Inkscape arc (ADR-0025)", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const box = { type: "ellipse" as const, parentId, x: 40, y: 50, width: 120, height: 60 };
  const [slice, chord, open, whole] = createNodes(doc, [
    { ...box, endAngle: 270 },
    { ...box, endAngle: 270, arcType: "chord" },
    { ...box, startAngle: 90, endAngle: 45, arcType: "open" },
    // Whole, but not the defaults, so it keeps its arc type.
    { ...box, startAngle: 30, endAngle: 30, arcType: "chord" },
  ]).nodes;
  const svg = toSvg(doc);
  const at =
    'sodipodi:type="arc" sodipodi:cx="100" sodipodi:cy="80" sodipodi:rx="60" sodipodi:ry="30"';
  for (const n of [slice, chord, open, whole]) {
    expect(svg).toContain(`d="${formatPath(shapeSegments(n as ShapeNode))}"`);
  }
  expect(svg).toContain(
    `<path ${at} sodipodi:start="0" sodipodi:end="${(3 * Math.PI) / 2}" sodipodi:arc-type="slice" d="M 160 80 C `,
  );
  expect(svg).toContain(
    `<path ${at} sodipodi:start="0" sodipodi:end="${(3 * Math.PI) / 2}" sodipodi:arc-type="chord" sodipodi:open="true" d="M 160 80 C `,
  );
  expect(svg).toContain(
    `<path ${at} sodipodi:start="${Math.PI / 2}" sodipodi:end="${Math.PI / 4}" sodipodi:arc-type="arc" sodipodi:open="true" d="M 100 110 C `,
  );
  expect(svg).toContain(
    `sodipodi:start="${Math.PI / 6}" sodipodi:end="${Math.PI / 6}" sodipodi:arc-type="chord"`,
  );
  expect(svg.match(/<ellipse /g)).toBeNull();
});

it("paints an Appearance stack bottom to top in a <g kalamo:stack>, with Stroke attributes only when set", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const [line] = createNodes(doc, [
    {
      type: "line",
      parentId,
      x1: 0,
      y1: 0,
      x2: 10,
      y2: 0,
      appearance: {
        fills: [{ color: "#111111" }, { color: "#222222" }],
        strokes: [
          { color: "#333333", width: 4, cap: "round", join: "bevel", dash: [4, 2] },
          { color: "#44444480" },
        ],
      },
    },
  ]).nodes;
  const svg = toSvg(doc);
  expect(svg).toContain(
    `<g id="z-${line?.id}" kalamo:stack="true"><line x1="0" y1="0" x2="10" y2="0" fill="#111111"/>`,
  );
  const colors = [...svg.matchAll(/(?:fill|stroke)="(#\w+)"/g)].map((m) => m[1]);
  expect(colors).toEqual(["#111111", "#222222", "#333333", "#444444"]);
  expect(svg).toContain(
    'stroke="#333333" stroke-width="4" stroke-linecap="round" stroke-linejoin="bevel" stroke-dasharray="4 2"/>',
  );
  expect(svg).toContain(
    'stroke="#444444" stroke-opacity="0.502" stroke-width="1" stroke-miterlimit="10"/>',
  );
});

it("writes a colour's alpha as fill-opacity and stroke-opacity, which Inkscape 1.2 reads", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  createNodes(doc, [
    {
      type: "rect",
      parentId,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      appearance: { fills: [{ color: "#FF000080" }], strokes: [{ color: "#00000060" }] },
    },
  ]);
  const svg = toSvg(doc, undefined, { background: "#11223340" });
  expect(svg).toContain(
    'fill="#FF0000" fill-opacity="0.502" stroke="#000000" stroke-opacity="0.376"',
  );
  expect(svg).toContain('fill="#112233" fill-opacity="0.251" kalamo:background="true"');
  expect(svg).not.toMatch(/="#\w{8}"/);
});

it("writes an empty Appearance as fill none, and a hidden or translucent Node's style", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const [bare, hidden, faded] = createNodes(doc, [
    { type: "rect", parentId, x: 0, y: 0, width: 1, height: 1, appearance: {} },
    { type: "rect", parentId, x: 0, y: 0, width: 1, height: 1 },
    { type: "rect", parentId, x: 0, y: 0, width: 1, height: 1 },
  ]).nodes;
  if (!bare || !hidden || !faded) throw new Error("setup");
  hidden.visible = false;
  faded.opacity = 0.5;
  faded.blendMode = "multiply";
  const svg = toSvg(doc);
  expect(svg).toContain(`id="z-${bare.id}" fill="none"/>`);
  expect(svg).toContain(
    `id="z-${hidden.id}" fill="#FFFFFF" stroke="#000000" stroke-width="1" stroke-miterlimit="10" style="display:none"/>`,
  );
  expect(svg).toContain(`style="opacity:0.5;mix-blend-mode:multiply"/></g></svg>`);
});

it("writes every Node's id, name, lock, tags and meta, and Layers as Inkscape layers", () => {
  const { doc, defaultLayerId } = newDoc();
  const [rect, layer] = createNodes(doc, [
    {
      type: "rect",
      parentId: defaultLayerId,
      name: 'Card "A"\nback',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      tags: ["badge"],
      meta: { note: 'say "hi"' },
      appearance: { fills: [{ color: "#FF0000" }] },
    },
    { type: "layer", name: "Guides" },
  ]).nodes;
  if (!rect || !layer) throw new Error("setup");
  layer.visible = false;
  layer.locked = true;
  rect.locked = true;
  const svg = toSvg(doc);
  expect(svg).toContain(
    `<g id="z-${defaultLayerId}" inkscape:label="Layer 1" inkscape:groupmode="layer"><rect x="0" y="0" width="1" height="1" ` +
      `id="z-${rect.id}" inkscape:label="Card &quot;A&quot;&#10;back" sodipodi:insensitive="true" ` +
      `kalamo:tags="[&quot;badge&quot;]" kalamo:meta="{&quot;note&quot;:&quot;say \\&quot;hi\\&quot;&quot;}" fill="#FF0000"/></g>`,
  );
  expect(svg).toContain(
    `<g id="z-${layer.id}" inkscape:label="Guides" sodipodi:insensitive="true" inkscape:groupmode="layer" style="display:none"></g></svg>`,
  );
});

it("writes a leaf's matrix on its own element, and a stack's on its <g>", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const [turned, both] = createNodes(doc, [
    { type: "rect", parentId, x: 10, y: 10, width: 50, height: 30 },
    { type: "rect", parentId, x: 0, y: 0, width: 1, height: 1 },
  ]).nodes;
  if (!turned || !both) throw new Error("setup");
  turned.transform = [0, 1, -1, 0, 60, -10];
  both.transform = [0.1234567, 0, 0, 1, 0, 0];
  both.opacity = 0.5;
  if (both.type !== "rect") throw new Error("setup");
  both.appearance.fills.push({ type: "solid", color: "#00FF00" });
  const svg = toSvg(doc);
  // At the 6 decimals a matrix is stored in, so importing the file gives the same matrix back.
  expect(svg).toContain(`id="z-${turned.id}" transform="matrix(0 1 -1 0 60 -10)" fill="#FFFFFF"`);
  expect(svg).toContain(
    `<g id="z-${both.id}" transform="matrix(0.123457 0 0 1 0 0)" kalamo:stack="true" style="opacity:0.5"><rect`,
  );
});

it("writes Point Type as one <text> in its font family, a line tspan per line", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  createNodes(doc, [
    { type: "text", parentId, x: 10, y: 50, content: "Hi\n\nHo" },
    {
      type: "text",
      parentId,
      x: 0,
      y: 20,
      content: 'a<b&"c"',
      fontSize: 24,
      leading: 30,
      appearance: { fills: [{ color: "#FF0000" }], strokes: [{ color: "#0000FF", width: 2 }] },
    },
  ]);
  const svg = toSvg(doc);
  expect(svg).toMatch(
    /<text x="10" y="50" font-family="Source Sans 3" font-size="12" id="z-\w+" fill="#000000" style="font-kerning:none;line-height:1.2" xml:space="preserve"><tspan sodipodi:role="line" x="10" y="50">Hi<\/tspan><tspan sodipodi:role="line" x="10" y="64.4"><\/tspan><tspan sodipodi:role="line" x="10" y="78.8">Ho<\/tspan><\/text>/,
  );
  expect(svg).toMatch(
    /<text x="0" y="20" font-family="Source Sans 3" font-size="24" id="z-\w+" fill="#FF0000" stroke="#0000FF" stroke-width="2" stroke-miterlimit="10" style="font-kerning:none;line-height:30px" xml:space="preserve"><tspan sodipodi:role="line" x="0" y="20">a&lt;b&amp;&quot;c&quot;<\/tspan><\/text>/,
  );
});

it("splits a line for resvg where its drawing family changes, each chunk at its x (ADR-0063)", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  createNodes(doc, [
    {
      type: "text",
      parentId,
      x: 0,
      y: 20,
      content: "Hi 小动x",
      fontSize: 10,
      tracking: 100,
      ranges: [{ start: 1, end: 4, rotation: 5 }],
    },
  ]);
  const line = (svg: string) =>
    /<tspan sodipodi:role="line"[^>]*>(.*?)<\/tspan><\/text>/.exec(svg)?.[1];
  // Origins: H 6.52 + 1 of tracking, i 2.46 + 1, space 2 + 1, 小 10 + 1, 动 10 + 1.
  expect(line(toSvg(doc, undefined, { resvg: true }))).toBe(
    'H<tspan rotate="5">i </tspan><tspan x="13.98" rotate="5" font-family="Noto Sans SC">小</tspan>' +
      '<tspan font-family="Noto Sans SC">动</tspan><tspan x="35.98">x</tspan>',
  );
  // Export keeps one run per override, as Inkscape and browsers fall back per character, and a
  // fallback run shrinks its line-height so Inkscape stacks by leading alone (ADR-0080).
  expect(line(toSvg(doc))).toBe(
    'H<tspan rotate="5">i </tspan><tspan rotate="5" style="line-height:0.948">小</tspan>' +
      '<tspan style="line-height:0.948">动</tspan>x',
  );
});

it("writes a range's family as written, and for resvg the bundled family each chunk draws in (ADR-0068)", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  createNodes(doc, [
    {
      type: "text",
      parentId,
      x: 0,
      y: 20,
      content: "Hi Hi",
      fontSize: 10,
      ranges: [
        { start: 0, end: 2, fontFamily: "Helvetica" },
        { start: 3, end: 5, fontFamily: "Noto Sans SC" },
      ],
    },
  ]);
  const line = (svg: string) =>
    /<tspan sodipodi:role="line"[^>]*>(.*?)<\/tspan><\/text>/.exec(svg)?.[1];
  expect(line(toSvg(doc))).toBe(
    `<tspan font-family="Helvetica">Hi</tspan> <tspan font-family="Noto Sans SC" style="line-height:0.948">Hi</tspan>`,
  );
  // Helvetica draws in Source Sans 3, the text's first family; Noto Sans SC in itself, from its x:
  // H 6.52, i 2.46 and the space 2.
  expect(line(toSvg(doc, undefined, { resvg: true }))).toBe(
    'Hi <tspan x="10.98" font-family="Noto Sans SC">Hi</tspan>',
  );
});

it("writes a text's style as font-weight and font-style, the stored style and not the face drawn", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  createNodes(doc, [
    { type: "text", parentId, x: 0, y: 20, content: "a", fontStyle: "Semibold Italic" },
    { type: "text", parentId, x: 0, y: 40, content: "b", fontStyle: "Bold" },
  ]);
  const svg = toSvg(doc);
  expect(svg).toContain(
    'font-family="Source Sans 3" font-size="12" font-weight="600" font-style="italic" id=',
  );
  expect(svg).toContain('font-family="Source Sans 3" font-size="12" font-weight="700" id=');
});

const areaText = (content: string, extra: object = {}) => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const [node] = createNodes(doc, [
    {
      type: "text",
      kind: "area",
      parentId,
      x: 150,
      y: 20,
      width: 100,
      height: 80,
      content,
      ...extra,
    },
  ]).nodes;
  return { svg: toSvg(doc), id: node?.id };
};

it("writes Area Type as shape-inside a <defs> rect, with a positioned tspan per shown line", () => {
  const { svg, id } = areaText(
    "The quick brown fox jumps over the lazy dog again and again.\nNew para",
  );
  const lines = [
    "The quick brown ",
    "fox jumps over the ",
    "lazy dog again and ",
    "again.&#10;",
    "New para",
  ]
    .map((t, i) => `<tspan x="150" y="${[30.25, 44.65, 59.05, 73.45, 87.85][i]}">${t}</tspan>`)
    .join("");
  expect(svg).toContain(
    `<defs><rect id="area-z-${id}" x="150" y="20" width="100" height="80"/></defs><text font-family="Source Sans 3" font-size="12" id="z-${id}" fill="#000000" style="shape-inside:url(#area-z-${id});white-space:pre;font-kerning:none;line-height:1.2" xml:space="preserve">${lines}</text>`,
  );
  expect(svg).not.toContain("visibility:hidden");
});

it("writes Area Type's overflow in a hidden tspan, so every character stays in the file", () => {
  const { svg } = areaText("one\ntwo\nthree", { height: 20 });
  expect(svg).toMatch(
    /y="30.25">one&#10;<\/tspan><tspan style="visibility:hidden">two&#10;three<\/tspan><\/text>/,
  );
});

describe("alignment (ADR-0077)", () => {
  /** An SVG with its generated ids masked, to compare two Documents byte for byte. */
  const bytes = (svg: string) => svg.replace(/z-\w+/g, "z-");
  const pointText = (alignment?: Alignment) => {
    const { doc, defaultLayerId: parentId } = newDoc();
    createNodes(doc, [
      {
        type: "text",
        parentId,
        x: 100,
        y: 50,
        content: "Hi\nHHH",
        ...(alignment && { alignment }),
      },
    ]);
    return doc;
  };

  it("writes Point Type's text-align and text-anchor as Inkscape does, its lines at the anchor", () => {
    const left = toSvg(pointText());
    expect(bytes(toSvg(pointText("left")))).toBe(bytes(left));
    for (const [alignment, style] of [
      ["center", "text-align:center;text-anchor:middle"],
      ["right", "text-align:end;text-anchor:end"],
      ["justify", "text-align:justify;text-anchor:start"],
    ] as const) {
      const svg = toSvg(pointText(alignment));
      expect(svg).toContain(`style="font-kerning:none;line-height:1.2;${style}"`);
      expect(svg).toContain('<tspan sodipodi:role="line" x="100" y="50">Hi</tspan>');
      expect(svg).toContain('<tspan sodipodi:role="line" x="100" y="64.4">HHH</tspan>');
    }
  });

  it("starts resvg's Point Type lines where the layout puts them, with no anchor", () => {
    const doc = pointText("right");
    const svg = toSvg(doc, undefined, { resvg: true });
    const [n] = [...doc.nodes.values()].filter((x) => x.type === "text") as TextNode[];
    const lines = layoutText(n as TextNode).lines;
    expect(svg).not.toContain("text-anchor");
    for (const l of lines)
      expect(svg).toContain(`x="${formatNumber(l.x)}" y="${formatNumber(l.y)}">${l.text}<`);
  });

  it("writes Area Type's text-align only, its lines at their aligned starts", () => {
    const left = areaText("The quick brown fox jumps over the lazy dog again.").svg;
    expect(
      bytes(
        areaText("The quick brown fox jumps over the lazy dog again.", { alignment: "left" }).svg,
      ),
    ).toBe(bytes(left));
    const { svg } = areaText("The quick brown fox jumps over the lazy dog again.", {
      alignment: "center",
    });
    expect(svg).toContain('line-height:1.2;text-align:center"');
    expect(svg).not.toContain("text-anchor");
    const xs = [...svg.matchAll(/<tspan x="([^"]+)"/g)].map((m) => Number(m[1]));
    expect(xs.every((x) => x > 150)).toBe(true);
  });

  it("starts each word of a justified line at its own x, so resvg draws where the layout does", () => {
    const content = "The quick brown fox jumps over the lazy dog again.";
    const { svg, id } = areaText(content, { alignment: "justify" });
    expect(svg).toContain("text-align:justify");
    const { doc, defaultLayerId: parentId } = newDoc();
    const [n] = createNodes(doc, [
      {
        type: "text",
        kind: "area",
        parentId,
        x: 150,
        y: 20,
        width: 100,
        height: 80,
        content,
        alignment: "justify",
      },
    ]).nodes as [TextNode];
    const g = glyphs(n);
    const first = layoutText(n).lines[0] as { text: string };
    // "The quick brown ": "quick" and "brown" each start a chunk at their glyph's x.
    expect(svg).toContain(
      `<tspan x="150" y="30.25">The <tspan x="${formatNumber((g[4] as { x: number }).x)}">quick </tspan>`,
    );
    expect(first.text).toBe("The quick brown ");
    expect(svg).toContain(`id="z-${id}"`);
    expect(toSvg(doc, undefined, { resvg: true })).toContain(
      `x="${formatNumber((g[10] as { x: number }).x)}">brown `,
    );
  });
});

it("writes one <defs> before an Area Type's stack, for every paint to flow in", () => {
  const { svg, id } = areaText("Hi", {
    appearance: { fills: [{ color: "#FF0000" }, { color: "#00FF00" }] },
  });
  expect(svg.match(/<defs>/g)).toHaveLength(1);
  expect(svg).toContain(`</defs><g id="z-${id}" kalamo:stack="true">`);
  expect(svg.match(new RegExp(`shape-inside:url\\(#area-z-${id}\\)`, "g"))).toHaveLength(2);
});

describe("tracking and Character Ranges (ADR-0029)", () => {
  const svgOf = (extra: object, content = "Hello") => {
    const { doc, defaultLayerId: parentId } = newDoc();
    createNodes(doc, [{ type: "text", parentId, x: 0, y: 20, content, ...extra } as never]);
    return toSvg(doc);
  };

  it("writes tracking as letter-spacing, and a nested tspan per span with overrides", () => {
    const svg = svgOf({
      fontSize: 20,
      tracking: 100,
      ranges: [
        { start: 0, end: 1, fill: "#FF000080" },
        { start: 2, end: 4, baselineShift: 3, rotation: -15 },
      ],
    });
    expect(svg).toContain('font-size="20" letter-spacing="2" id=');
    expect(svg).toContain(
      '<tspan sodipodi:role="line" x="0" y="20"><tspan fill="#FF0000" fill-opacity="0.502">H</tspan>e<tspan baseline-shift="3" rotate="-15">ll</tspan>o</tspan>',
    );
  });

  it("writes a range's tracking as its tspan's letter-spacing (ADR-0068)", () => {
    const svg = svgOf({
      fontSize: 20,
      tracking: 100,
      ranges: [
        { start: 1, end: 2, tracking: 250 },
        { start: 2, end: 3, tracking: 0 },
      ],
    });
    expect(svg).toContain(
      'H<tspan letter-spacing="5">e</tspan><tspan letter-spacing="0">l</tspan>lo</tspan>',
    );
  });

  it("writes a range's style as the weight and italic that differ from the text's (ADR-0068)", () => {
    const svg = svgOf({
      fontStyle: "Bold",
      ranges: [
        { start: 0, end: 1, fontStyle: "Regular" },
        { start: 1, end: 2, fontStyle: "Bold Italic" },
        { start: 2, end: 3, fontStyle: "Light Italic" },
      ],
    });
    expect(svg).toContain(
      '<tspan font-weight="400">H</tspan><tspan font-style="italic">e</tspan><tspan font-weight="300" font-style="italic">l</tspan>lo',
    );
  });

  it("writes a range's size, and a resized run's own letter-spacing when it tracks (ADR-0068)", () => {
    const tracked = svgOf({
      fontSize: 10,
      tracking: 100,
      ranges: [
        { start: 0, end: 1, fontSize: 20 },
        { start: 1, end: 2, fontSize: 20, tracking: 0 },
        { start: 2, end: 3, fontSize: 30, tracking: 50 },
      ],
    });
    expect(tracked).toContain(
      '<tspan font-size="20" letter-spacing="2">H</tspan><tspan font-size="20" letter-spacing="0">e</tspan><tspan font-size="30" letter-spacing="1.5">l</tspan>lo',
    );
    expect(svgOf({ ranges: [{ start: 0, end: 1, fontSize: 20 }] })).toContain(
      '<tspan font-size="20">H</tspan>ello',
    );
  });

  it("writes no range fill into an element that paints no Fill", () => {
    const svg = svgOf({
      appearance: { fills: [], strokes: [{ color: "#000000", width: 1 }] },
      ranges: [{ start: 0, end: 1, fill: "#FF0000", rotation: 5 }],
    });
    expect(svg).toContain('<tspan rotate="5">H</tspan>');
    expect(svg).not.toContain('fill="#FF0000"');
  });

  it("writes an opaque range fill as opaque inside a translucent Fill", () => {
    const svg = svgOf({
      appearance: { fills: [{ color: "#00000080" }], strokes: [] },
      ranges: [{ start: 0, end: 1, fill: "#FF0000" }],
    });
    expect(svg).toContain('<tspan fill="#FF0000" fill-opacity="1">H</tspan>');
  });

  it("writes a range fill in every Fill's element and no Stroke's", () => {
    const svg = svgOf({
      appearance: {
        fills: [{ color: "#000000" }, { color: "#00FF00" }],
        strokes: [{ color: "#0000FF", width: 1 }],
      },
      ranges: [{ start: 0, end: 1, fill: "#FF0000" }],
    });
    expect(svg.match(/<tspan fill="#FF0000">H<\/tspan>/g)).toHaveLength(2);
    expect(svg.match(/<text/g)).toHaveLength(3);
  });

  it("writes a range stroke in every Stroke's element and no Fill's (ADR-0068)", () => {
    const svg = svgOf({
      appearance: {
        fills: [{ color: "#000000" }],
        strokes: [
          { color: "#0000FF80", width: 1 },
          { color: "#00FF00", width: 2 },
        ],
      },
      ranges: [
        { start: 0, end: 1, stroke: "#FF0000" },
        { start: 1, end: 2, stroke: "#FF000080" },
      ],
    });
    expect(svg).toContain(
      '<tspan stroke="#FF0000" stroke-opacity="1">H</tspan><tspan stroke="#FF0000" stroke-opacity="0.502">e</tspan>',
    );
    expect(svg).toContain(
      '<tspan stroke="#FF0000">H</tspan><tspan stroke="#FF0000" stroke-opacity="0.502">e</tspan>',
    );
    expect(svg.match(/<tspan stroke=/g)).toHaveLength(4);
    expect(svgOf({ ranges: [{ start: 0, end: 1, stroke: "#FF0000" }] })).not.toContain(
      'stroke="#FF0000"',
    );
  });

  it("splits Area Type's hidden overflow at range boundaries too", () => {
    const { svg } = areaText("ab\ncd", {
      fontSize: 12,
      height: 14,
      ranges: [{ start: 3, end: 5, fill: "#FF0000" }],
    });
    expect(svg).toContain(
      '<tspan style="visibility:hidden"><tspan fill="#FF0000">cd</tspan></tspan>',
    );
  });
});

it("writes the root in pt with its scope, and each Artboard as an Inkscape page", () => {
  const { doc } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [
      { width: 200, height: 100 },
      { name: "Card & back", x: 300, y: 0, width: 50, height: 50, background: "#FFEEDD" },
    ],
  });
  const [one, two] = doc.artboards;
  if (!one || !two) throw new Error("setup");
  const svg = toSvg(doc);
  expect(svg).toMatch(
    new RegExp(
      '^<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ' +
        'xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:kalamo="https://kalamo.cc/ns/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
        'width="200pt" height="100pt" viewBox="0 0 200 100" kalamo:scope="doc" sodipodi:docname="Doc.svg">' +
        '<sodipodi:namedview inkscape:document-units="pt">' +
        `<inkscape:page x="0" y="0" width="200" height="100" id="z-${one.id}" inkscape:label="Artboard 1"/>` +
        `<inkscape:page x="300" y="0" width="50" height="50" id="z-${two.id}" inkscape:label="Card &amp; back"/>` +
        "</sodipodi:namedview>" +
        `<rect x="300" y="0" width="50" height="50" fill="#FFEEDD" kalamo:artboard="${two.id}" sodipodi:insensitive="true"/><g`,
    ),
  );
  expect(svg).not.toContain(LEGACY_SVG_NS);
  expect(svg).not.toMatch(new RegExp(LEGACY_NAME, "i"));
  // Inkscape resizes the page at (0,0) to the viewBox: the export's viewBox is that page, else
  // the first.
  expect(svgRect(doc)).toEqual(one.frame);
  const moved = { ...doc, artboards: [{ ...one, frame: { ...one.frame, x: 100, y: 50 } }, two] };
  expect(svgRect(moved)).toEqual(moved.artboards[0]?.frame);
  const swapped = {
    ...moved,
    artboards: [moved.artboards[0], { ...two, frame: { ...two.frame, x: 0 } }],
  };
  expect(svgRect(swapped as typeof doc)).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  expect(svgRect(doc, { artboardId: two.id })).toEqual(two.frame);
  const second = toSvg(doc, svgRect(doc, { artboardId: two.id }), {
    scope: { artboardId: two.id },
  });
  expect(second).toContain(`kalamo:scope="artboard:${two.id}"`);
  expect(second.match(/<inkscape:page /g)).toHaveLength(1);
  expect(second).toContain(`<inkscape:page x="300" y="0" width="50" height="50" id="z-${two.id}"`);
  const layer = [...doc.nodes.keys()];
  const nodes = toSvg(doc, { x: 0, y: 0, width: 1, height: 1 }, { scope: { nodeIds: layer } });
  expect(nodes).toContain(`width="1pt" height="1pt" viewBox="0 0 1 1"`);
  expect(nodes).toContain(`kalamo:scope="nodes:${layer.join(",")}"`);
  expect(nodes).toContain('<sodipodi:namedview inkscape:document-units="pt"/>');
  const rect = { x: 1, y: 2, width: 3, height: 4 };
  expect(toSvg(doc, rect, { scope: { rect } })).toContain(
    'kalamo:scope="rect:1,2,3,4" sodipodi:docname="Doc.svg"><sodipodi:namedview inkscape:document-units="pt"/><rect',
  );
});

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { data?: unknown }).data;
  }
  throw new Error("did not throw");
};

it("resolves each Render Scope to the rect the image covers", () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [
      { width: 200, height: 100 },
      { x: 300, y: 0, width: 50, height: 50 },
    ],
  });
  const [rect, group] = createNodes(doc, [
    {
      type: "rect",
      parentId,
      x: 10,
      y: 10,
      width: 50,
      height: 30,
      appearance: { strokes: [{ color: "#000000", width: 4 }] },
    },
    { type: "group", parentId, children: [] },
  ]).nodes;
  if (!rect || !group) throw new Error("setup");
  const second = doc.artboards[1];
  if (!second) throw new Error("setup");
  expect(scopeRect(doc)).toEqual({ x: 0, y: 0, width: 350, height: 100 });
  expect(scopeRect(doc, { artboardId: second.id })).toEqual(second.frame);
  expect(scopeRect(doc, { rect: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  });
  expect(scopeRect(doc, { nodeIds: [rect.id, group.id] })).toEqual({
    x: 8,
    y: 8,
    width: 54,
    height: 34,
  });
  expect(errorOf(() => scopeRect(doc, { artboardId: "nope" }))).toMatchObject({
    code: "ARTBOARD_NOT_FOUND",
    path: "scope.artboardId",
  });
  expect(errorOf(() => scopeRect(doc, { nodeIds: [rect.id, "nope"] }))).toMatchObject({
    code: "NODE_NOT_FOUND",
    path: "scope.nodeIds[1]",
  });
  expect(errorOf(() => scopeRect(doc, { nodeIds: [group.id] }))).toMatchObject({
    code: "NOTHING_TO_RENDER",
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

it("draws only the listed Nodes and what they contain, inside their ancestors", () => {
  const { doc, a, inA } = scene();
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  const group = toSvg(doc, rect, { scope: { nodeIds: [a.id] } });
  expect(group).toMatch(
    /<svg[^>]*><sodipodi:namedview[^>]*\/><g [^>]*><g [^>]*><rect[^>]*#AA0000"\/><line[^>]*#00AA00"[^>]*\/><\/g><\/g><\/svg>$/,
  );
  expect(group).not.toContain("#0000AA");
  // A selection export has no Artboard background.
  expect(group).not.toContain("#FFFFFF");
  expect(toSvg(doc, rect, { scope: { nodeIds: [inA.id] } })).toMatch(
    /<svg[^>]*><sodipodi:namedview[^>]*\/><g [^>]*><g [^>]*><rect[^>]*#AA0000"\/><\/g><\/g><\/svg>$/,
  );
  // A hidden ancestor is written with its listed child, which stays undrawn.
  a.visible = false;
  expect(toSvg(doc, rect, { scope: { nodeIds: [inA.id] } })).toMatch(
    new RegExp(
      `<g id="z-${a.id}" style="display:none"><rect[^>]*id="z-${inA.id}" fill="#AA0000"/></g></g></svg>$`,
    ),
  );
});

it("fills the whole rect with background beneath the Artboard backgrounds", () => {
  const { doc, a } = scene();
  const rect = { x: -5, y: -5, width: 300, height: 200 };
  expect(toSvg(doc, rect, { background: "#112233" })).toMatch(
    /<\/sodipodi:namedview><rect x="-5" y="-5" width="300" height="200" fill="#112233" kalamo:background="true"\/><rect x="0" y="0" width="200" height="100" fill="#FFFFFF" kalamo:artboard="\w+" sodipodi:insensitive="true"\/><g /,
  );
  expect(toSvg(doc, rect, { background: "#112233", scope: { nodeIds: [a.id] } })).toMatch(
    /<svg[^>]*><sodipodi:namedview[^>]*\/><rect[^>]*fill="#112233" kalamo:background="true"\/><g /,
  );
});

it("writes fill-rule evenodd on a Path and on each paint of its stack, and nothing for nonzero", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const d = "M 0 0 L 30 0 L 30 30 L 0 30 Z M 10 10 L 20 10 L 20 20 L 10 20 Z";
  const [ring, , plain] = createNodes(doc, [
    { type: "path", parentId, d, fillRule: "evenodd" },
    {
      type: "path",
      parentId,
      d,
      fillRule: "evenodd",
      appearance: { fills: [{ color: "#111111" }, { color: "#222222" }] },
    },
    { type: "path", parentId, d },
  ]).nodes;
  const svg = toSvg(doc);
  expect(svg).toContain(`<path d="${d}" fill-rule="evenodd" id="z-${ring?.id}"`);
  expect(svg).toContain(
    `kalamo:stack="true"><path d="${d}" fill-rule="evenodd" fill="#111111"/><path d="${d}" fill-rule="evenodd" fill="#222222"/></g>`,
  );
  expect(svg).toContain(`<path d="${d}" id="z-${plain?.id}"`);
});

/** A Group of a rect under a Clipping Path, the ellipse, and a rect above it. */
function clipped() {
  const { doc, defaultLayerId } = newDoc();
  const [below, clip, above] = createNodes(doc, [
    { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 10, height: 10 },
    { type: "ellipse", parentId: defaultLayerId, x: 2, y: 2, width: 4, height: 4 },
    { type: "rect", parentId: defaultLayerId, x: 5, y: 5, width: 10, height: 10 },
  ]).nodes as [ShapeNode, ShapeNode, ShapeNode];
  const { group } = makeMask(doc, { clipNodeId: clip.id, contentIds: [below.id, above.id] });
  return { doc, group, below, clip, above };
}

it("writes a Clipping Mask as <g clip-path> with its Clipping Path in an inline <clipPath>, in place", () => {
  const { doc, group, below, clip, above } = clipped();
  const svg = toSvg(doc);
  expect(svg).toContain(
    `<g id="z-${group.id}" clip-path="url(#clip-z-${group.id})"><rect x="0" y="0" width="10" height="10" id="z-${below.id}"`,
  );
  expect(svg).toContain(
    `<clipPath id="clip-z-${group.id}" clipPathUnits="userSpaceOnUse"><circle cx="4" cy="4" r="2" id="z-${clip.id}" fill="none"/></clipPath><rect x="5" y="5" width="10" height="10" id="z-${above.id}"`,
  );
});

it("writes an evenodd Clipping Path's clip-rule, and its Fills as a clip-fill group after the paints below Contents (ADR-0051)", () => {
  const { doc, defaultLayerId } = newDoc();
  const [content, clip] = createNodes(doc, [
    { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 10, height: 10 },
    { type: "path", parentId: defaultLayerId, d: "M 0 0 L 9 0 L 9 9 Z", fillRule: "evenodd" },
  ]).nodes as [ShapeNode, ShapeNode];
  const { group } = makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
  const stops = [
    { offset: 0, color: "#000000" },
    { offset: 1, color: "#FFFFFF" },
  ];
  const gradient = { type: "linear" as const, stops, start: { x: 0, y: 0 }, end: { x: 9, y: 0 } };
  const painted = {
    fills: [
      { type: "solid" as const, color: "#FF0000" },
      { type: "gradient" as const, gradient },
    ],
    strokes: [],
  };
  const path = doc.nodes.get(clip.id) as ShapeNode;
  doc.nodes.set(clip.id, { ...path, appearance: painted, opacity: 0.5 });
  const below = { fills: [{ color: "#0000FF" }], contents: 1 };
  updateNodes(doc, [{ nodeId: group.id, patch: { appearance: below } }]);
  const svg = toSvg(doc);
  expect(svg).toContain(
    `<path d="M 0 0 L 9 0 L 9 9 Z" fill-rule="evenodd" id="z-${clip.id}" fill="none" clip-rule="evenodd"/></clipPath>`,
  );
  expect(svg).toContain(`<g id="z-${group.id}" clip-path="url(#clip-z-${group.id})">`);
  expect(svg).not.toContain("kalamo:clipped");
  expect(svg).toContain(
    `</g><defs><linearGradient id="fill-1-z-${clip.id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="9" y2="0">`,
  );
  expect(svg).toContain(
    `</linearGradient></defs><g kalamo:paint="clip-fill" sodipodi:insensitive="true" inkscape:label="Clipping Path Fill" style="opacity:0.5"><g kalamo:stack="true"><path d="M 0 0 L 9 0 L 9 9 Z" fill-rule="evenodd" fill="#FF0000"/><path d="M 0 0 L 9 0 L 9 9 Z" fill-rule="evenodd" fill="url(#fill-1-z-${clip.id})"/></g></g><rect x="0" y="0" width="10" height="10" id="z-${content.id}"`,
  );
  // The container's Fill below Contents comes first.
  expect(svg.indexOf('kalamo:paint="true"')).toBeLessThan(svg.indexOf("clip-fill"));
});

/** A Layer "L" holding a sublayer with a rect, then its Clipping Path, a circle (ADR-0053). */
function clippedLayer() {
  const { doc } = newDoc();
  const [layer] = createNodes(doc, [{ type: "layer", name: "L" }]).nodes as [ShapeNode];
  const [sub] = createNodes(doc, [
    { type: "layer", parentId: layer.id },
    { type: "ellipse", parentId: layer.id, x: 2, y: 2, width: 4, height: 4 },
  ]).nodes as [ShapeNode];
  createNodes(doc, [{ type: "rect", parentId: sub.id, x: 0, y: 0, width: 10, height: 10 }]);
  const [clip] = makeMask(doc, { layerId: layer.id }).updated as [ShapeNode];
  return { doc, layer, sub, clip };
}

it("writes a Layer Clipping Mask as clip-path on the layer <g> with an inline <clipPath> (ADR-0053)", () => {
  const { doc, layer, clip } = clippedLayer();
  const svg = toSvg(doc);
  expect(svg).toContain(
    `<g id="z-${layer.id}" inkscape:label="L" inkscape:groupmode="layer" clip-path="url(#clip-z-${layer.id})">`,
  );
  expect(svg).toContain(
    `<clipPath id="clip-z-${layer.id}" clipPathUnits="userSpaceOnUse"><circle cx="4" cy="4" r="2" id="z-${clip.id}" fill="none"/></clipPath></g>`,
  );
});

it("wraps a stroked Layer Clipping Mask's content, sublayers included, inside the layer <g> (ADR-0053)", () => {
  const { doc, layer, sub, clip } = clippedLayer();
  updateNodes(doc, [
    { nodeId: clip.id, patch: { appearance: { strokes: [{ color: "#00FF00" }] } } },
  ]);
  const svg = toSvg(doc);
  expect(svg).toContain(
    `<g id="z-${layer.id}" inkscape:label="L" inkscape:groupmode="layer"><g kalamo:clipped="true" clip-path="url(#clip-z-${layer.id})"><g id="z-${sub.id}" inkscape:groupmode="layer">`,
  );
  expect(svg).toMatch(
    /<\/clipPath><\/g><g kalamo:paint="clip-stroke"[^>]*><circle [^>]*stroke="#00FF00"[^>]*\/><\/g><\/g>/,
  );
});

it("wraps what a stroked Clipping Path clips, and writes its Strokes after, unclipped (ADR-0051)", () => {
  const { doc, group, below, clip, above } = clipped();
  const stroke = { color: "#00FF00", width: 2 };
  updateNodes(doc, [
    { nodeId: clip.id, patch: { appearance: { strokes: [stroke] }, blendMode: "multiply" } },
  ]);
  const wrapper = `<g kalamo:clipped="true" clip-path="url(#clip-z-${group.id})">`;
  const svg = toSvg(doc);
  expect(svg).toContain(
    `<g id="z-${group.id}">${wrapper}<rect x="0" y="0" width="10" height="10" id="z-${below.id}"`,
  );
  expect(svg).toContain(
    `<rect x="5" y="5" width="10" height="10" id="z-${above.id}" fill="#FFFFFF" stroke="#000000" stroke-width="1" stroke-miterlimit="10"/></g><g kalamo:paint="clip-stroke" sodipodi:insensitive="true" inkscape:label="Clipping Path Stroke" style="mix-blend-mode:multiply"><circle cx="4" cy="4" r="2" fill="none" stroke="#00FF00" stroke-width="2" stroke-miterlimit="10"/></g></g>`,
  );
  // A container paint above Contents goes in a second wrapper naming the same <clipPath>.
  const frame = { strokes: [{ color: "#FF00FF", width: 1 }] };
  updateNodes(doc, [{ nodeId: group.id, patch: { appearance: frame } }]);
  const framed = toSvg(doc);
  expect(framed).toContain(`stroke-miterlimit="10"/></g>${wrapper}<g kalamo:paint="true"`);
  expect(framed.split(`clip-path="url(#clip-z-${group.id})"`)).toHaveLength(3);
});

describe("a text Clipping Path (ADR-0052)", () => {
  /** A rect clipped by Area Type "one\ntwo\nthree" whose "two\nthree" overflows, with ranges. */
  const textClipped = () => {
    const { doc, defaultLayerId: parentId } = newDoc();
    const [content, clip] = createNodes(doc, [
      { type: "rect", parentId, x: 0, y: 0, width: 100, height: 100 },
      {
        type: "text",
        kind: "area",
        parentId,
        x: 10,
        y: 10,
        width: 80,
        height: 20,
        content: "one\ntwo\nthree",
      },
    ]).nodes as [ShapeNode, TextNode];
    const { group } = makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
    const ranges = [
      { start: 0, end: 1, fill: "#FF0000" },
      { start: 1, end: 2, rotation: 10 },
      { start: 4, end: 5, fill: "#00FF00" },
    ];
    updateNodes(doc, [{ nodeId: clip.id, patch: { ranges } }]);
    return { doc, group, clip };
  };

  it("writes the text in the <clipPath> with no paint, its overflow hidden, its frame before", () => {
    const { doc, group, clip } = textClipped();
    const svg = toSvg(doc);
    expect(svg).toContain(
      `<defs><rect id="area-z-${clip.id}" x="10" y="10" width="80" height="20"/></defs><clipPath id="clip-z-${group.id}" clipPathUnits="userSpaceOnUse"><text font-family="Source Sans 3" font-size="12" id="z-${clip.id}" fill="none" style="shape-inside:url(#area-z-${clip.id});`,
    );
    expect(svg).toContain(
      `>o<tspan rotate="10">n</tspan>e&#10;</tspan><tspan style="visibility:hidden">two&#10;three</tspan></text></clipPath>`,
    );
    expect(svg).not.toContain("clip-rule");
  });

  it("writes its painted copies as <text>, the Fill's with its Range Fills, the Stroke's with its Range Strokes", () => {
    const { doc, clip } = textClipped();
    updateNodes(doc, [
      {
        nodeId: clip.id,
        patch: {
          appearance: { fills: [{ color: "#000000" }], strokes: [{ color: "#0000FF", width: 1 }] },
          ranges: [
            { start: 0, end: 1, fill: "#FF0000" },
            { start: 1, end: 2, rotation: 10, stroke: "#FF00FF" },
            { start: 4, end: 5, fill: "#00FF00" },
          ],
        },
      },
    ]);
    const svg = toSvg(doc);
    const fill = svg.slice(svg.indexOf('kalamo:paint="clip-fill"'));
    expect(fill).toMatch(
      /^[^>]*><text [^>]*fill="#000000"[^>]*><tspan[^>]*><tspan fill="#FF0000">o<\/tspan>/,
    );
    expect(fill).toContain('<tspan style="visibility:hidden"><tspan fill="#00FF00">t</tspan>wo');
    const stroke = svg.slice(svg.indexOf('kalamo:paint="clip-stroke"'));
    expect(stroke).toMatch(/^[^>]*><text [^>]*fill="none" stroke="#0000FF"/);
    expect(stroke).not.toContain("#FF0000");
    expect(stroke).toContain('<tspan stroke="#FF00FF" rotate="10">n</tspan>');
    expect(fill.slice(0, fill.indexOf("clip-stroke"))).not.toContain("#FF00FF");
    // One frame for the <clipPath> and both copies.
    expect(svg.match(new RegExp(`id="area-z-${clip.id}"`, "g"))).toHaveLength(1);
  });
});

it("keeps the clip around a listed Node inside a Clipping Mask, and draws only that Node", () => {
  const { doc, group, below, clip } = clipped();
  let drawn: string[] = [];
  const svg = toSvg(doc, undefined, {
    scope: { nodeIds: [below.id] },
    trailer: (nodes) => {
      drawn = nodes.map((n) => n.id);
      return "";
    },
  });
  expect(svg).toContain(`clip-path="url(#clip-z-${group.id})"`);
  expect(svg).toContain(`id="z-${clip.id}"`);
  expect(drawn).toEqual([below.id]);
});

it("writes an Image as <image xlink:href>, which Inkscape 1.2 draws, with its file inlined", () => {
  const { doc, defaultLayerId } = newDoc();
  const src = "a".repeat(64);
  doc.images.set(src, { mime: "image/png", width: 2, height: 2 });
  const [image] = createNodes(doc, [
    { type: "image", parentId: defaultLayerId, src, x: 10, y: 20, width: 30, height: 40 },
  ]).nodes;
  const url = "data:image/png;base64,AAAA";
  const svg = toSvg(doc, undefined, { images: (id) => (id === src ? url : undefined) });
  expect(svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  expect(svg).toContain(
    `<image x="10" y="20" width="30" height="40" preserveAspectRatio="none" xlink:href="${url}" id="z-${image?.id}"/>`,
  );
  expect(() => toSvg(doc)).toThrow(
    expect.objectContaining({ data: expect.objectContaining({ code: "INVALID_IMAGE" }) }),
  );
});

it("writes a linked Image as its file, with kalamo:src when it has pixels, never the pixels (ADR-0042)", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const src = "a".repeat(64);
  doc.images.set(src, { mime: "image/png", width: 2, height: 2 });
  const [linked, missing] = createNodes(doc, [
    { type: "image", parentId, src, file: "photos/a b.png", x: 10, y: 20, width: 30, height: 40 },
    { type: "image", parentId, file: "gone.png", x: 0, y: 0, width: 8, height: 4 },
  ]).nodes;
  if (!missing) throw new Error("setup");
  missing.opacity = 0.5;
  missing.transform = [2, 0, 0, 2, 5, 0];
  const url = "data:image/png;base64,AAAA";
  const images = (id: string) => (id === src ? url : undefined);
  // No images needed: export writes no pixels for a linked Image.
  const svg = toSvg(doc);
  expect(svg).toContain(
    `<image x="10" y="20" width="30" height="40" preserveAspectRatio="none" xlink:href="photos/a b.png" kalamo:src="${src}" id="z-${linked?.id}"/>`,
  );
  expect(svg).toContain(
    `<image x="0" y="0" width="8" height="4" preserveAspectRatio="none" xlink:href="gone.png" id="z-${missing.id}" transform="matrix(2 0 0 2 5 0)" style="opacity:0.5"/>`,
  );
  // render draws the pixels, and a missing link's frame and diagonals in place, at the hairline.
  const drawn = toSvg(doc, undefined, { images, linked: "draw", hairline: 0.5 });
  expect(drawn).toContain(`xlink:href="${url}" id="z-${linked?.id}"/>`);
  expect(drawn).not.toContain("kalamo:src");
  expect(drawn).toContain(
    `<path d="M 5 0 L 21 0 L 21 8 L 5 8 Z M 5 0 L 21 8 M 21 0 L 5 8" id="z-${missing.id}" style="fill:none;stroke:#999999;stroke-width:0.5;opacity:0.5"/>`,
  );
});

describe("gradients (ADR-0026)", () => {
  const stops = [
    { offset: 0, color: "#1F5FBF" },
    { offset: 1, color: "#9FD0FF00" },
  ];
  const rectWith = (appearance: object) => {
    const { doc, defaultLayerId: parentId } = newDoc();
    const [rect] = createNodes(doc, [
      { type: "rect", parentId, x: 10, y: 20, width: 100, height: 50, appearance },
    ]).nodes;
    return { svg: toSvg(doc), id: rect?.id };
  };
  const stopsSvg =
    '<stop offset="0" stop-color="#1F5FBF"/><stop offset="1" stop-color="#9FD0FF" stop-opacity="0"/>';

  it("writes a linear Fill as a userSpaceOnUse gradient in a <defs> before its element", () => {
    const { svg, id } = rectWith({
      fills: [{ type: "gradient", gradient: { type: "linear", stops } }],
    });
    expect(svg).toContain(
      `<defs><linearGradient id="fill-0-z-${id}" gradientUnits="userSpaceOnUse" x1="10" y1="45" x2="110" y2="45">${stopsSvg}</linearGradient></defs>` +
        `<rect x="10" y="20" width="100" height="50" id="z-${id}" fill="url(#fill-0-z-${id})"/>`,
    );
  });

  it("writes a radial ellipse as a gradientTransform about its centre, and its focus inside it", () => {
    const radial = { type: "radial", stops, radius: 40, aspectRatio: 0.5, angle: 30 };
    const { svg, id } = rectWith({
      fills: [{ type: "gradient", gradient: { ...radial, focus: { x: 70, y: 45 } } }],
    });
    expect(svg).toContain(
      `<radialGradient id="fill-0-z-${id}" gradientUnits="userSpaceOnUse" cx="60" cy="45" r="40" fx="68.660254" fy="35" ` +
        `gradientTransform="matrix(0.866025 0.5 -0.25 0.433013 19.288476 -4.485572)">${stopsSvg}</radialGradient>`,
    );
    const round = rectWith({ fills: [{ type: "gradient", gradient: { type: "radial", stops } }] });
    expect(round.svg).toContain(
      `<radialGradient id="fill-0-z-${round.id}" gradientUnits="userSpaceOnUse" cx="60" cy="45" r="39.528">`,
    );
  });

  it("writes a gradient Stroke with its width, and a stack's gradients in one <defs>", () => {
    const linear = { type: "gradient", gradient: { type: "linear", stops } };
    const one = rectWith({ fills: [], strokes: [{ ...linear, width: 3, dash: [2, 1] }] });
    expect(one.svg).toContain(
      `fill="none" stroke="url(#stroke-0-z-${one.id})" stroke-width="3" stroke-miterlimit="10" stroke-dasharray="2 1"/>`,
    );
    const { svg, id } = rectWith({
      fills: [{ color: "#FF0000" }, linear],
      strokes: [linear],
    });
    expect(svg.match(/<defs>/g)).toHaveLength(1);
    expect(svg).toMatch(
      new RegExp(
        `<defs><linearGradient id="fill-1-z-${id}"[^]*<linearGradient id="stroke-0-z-${id}"[^]*</defs><g id="z-${id}" kalamo:stack="true">`,
      ),
    );
    expect(svg).toContain(`fill="url(#fill-1-z-${id})"/>`);
    expect(svg).toContain(`stroke="url(#stroke-0-z-${id})"`);
  });

  it("writes an Area Type's frame and gradient in one <defs>", () => {
    const { svg, id } = areaText("Hi", {
      appearance: { fills: [{ type: "gradient", gradient: { type: "linear", stops } }] },
    });
    expect(svg).toMatch(
      new RegExp(`<defs><rect id="area-z-${id}"[^>]*/><linearGradient id="fill-0-z-${id}"`),
    );
    expect(svg).toContain(`fill="url(#fill-0-z-${id})"`);
  });

  it("writes a midpoint as marked inserted stops, and kalamo:midpoint on its stop (ADR-0081)", () => {
    const mid = [
      { offset: 0, color: "#000000", midpoint: 0.25 },
      { offset: 1, color: "#FFFFFF" },
    ];
    const { svg } = rectWith({
      fills: [{ type: "gradient", gradient: { type: "linear", stops: mid } }],
    });
    const written = [...svg.matchAll(/<stop [^>]*\/>/g)].map((m) => m[0]);
    expect(written[0]).toBe('<stop offset="0" stop-color="#000000" kalamo:midpoint="0.25"/>');
    expect(written.at(-1)).toBe('<stop offset="1" stop-color="#FFFFFF"/>');
    const inserted = written.slice(1, -1);
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted.every((s) => s.includes('kalamo:simulated="true"'))).toBe(true);
  });
});

it("writes a container's paints as locked <g kalamo:paint> copies around its children (ADR-0043)", () => {
  const { doc, defaultLayerId } = newDoc();
  const [group, a, , p] = createNodes(doc, [
    {
      type: "group",
      parentId: defaultLayerId,
      appearance: {
        fills: [{ color: "#00FF00" }],
        strokes: [{ color: "#FF0000", width: 4 }],
        contents: 1,
      },
      children: [
        { type: "rect", x: 0, y: 0, width: 10, height: 10, appearance: {} },
        {
          type: "group",
          children: [{ type: "path", d: "M 0 0 L 5 0 L 5 5 Z", fillRule: "evenodd" }],
        },
      ],
    },
  ]).nodes;
  if (!group || !a || !p) throw new Error("setup");
  const copies = `<path d="M 0 0 L 10 0 L 10 10 L 0 10 Z"/><path d="M 0 0 L 5 0 L 5 5 Z" fill-rule="evenodd"/>`;
  const svg = toSvg(doc);
  expect(svg).toContain(
    `<g id="z-${group.id}"><g kalamo:paint="true" sodipodi:insensitive="true" inkscape:label="Fill" fill="#00FF00">${copies}</g><rect`,
  );
  expect(svg).toContain(
    `</g><g kalamo:paint="true" sodipodi:insensitive="true" inkscape:label="Stroke" fill="none" stroke="#FF0000" stroke-width="4" stroke-miterlimit="10">${copies}</g></g>`,
  );
  // A Group without an Appearance writes no paint.
  updateNodes(doc, [{ nodeId: group.id, patch: { appearance: null } }]);
  expect(toSvg(doc)).not.toContain("kalamo:paint");
});

it("paints a text child as a bare <text> copy, and an inner Clipping Mask's leaf under its <clipPath> (#106)", () => {
  const { doc, defaultLayerId } = newDoc();
  const [group, text, , clipped, clip] = createNodes(doc, [
    {
      type: "group",
      parentId: defaultLayerId,
      appearance: { fills: [{ color: "#00FF00" }], strokes: [{ color: "#FF0000", width: 4 }] },
      children: [
        {
          type: "text",
          x: 10,
          y: 50,
          content: "Hi",
          ranges: [{ start: 0, end: 1, fill: "#0000FF" }],
        },
        { type: "rect", x: 0, y: 0, width: 10, height: 10 },
        { type: "rect", x: 20, y: 0, width: 10, height: 10 },
        { type: "rect", x: 25, y: 0, width: 10, height: 10 },
      ],
    },
  ]).nodes;
  if (!group || !text || !clipped || !clip) throw new Error("setup");
  const mask = makeMask(doc, { clipNodeId: clip.id, contentIds: [clipped.id] }).group;
  doc.nodes.set(text.id, { ...text, transform: [2, 0, 0, 2, 0, 0] });
  const svg = toSvg(doc);
  const [fill, stroke] = [...svg.matchAll(/<g kalamo:paint="true"[^>]*>(.*?)<\/g><\/g>?/g)].map(
    (m) => m[0],
  );
  // One copy per leaf, the text in its own transform with no id and no range fill.
  expect(fill).toMatch(/^<g [^>]*fill="#00FF00"><text [^>]*transform="matrix\(2 0 0 2 0 0\)"/);
  expect(fill).not.toContain("#0000FF");
  expect(fill).not.toContain(`z-${text.id}`);
  expect(fill).toContain(
    `<g clip-path="url(#clip-z-${mask.id})"><path d="M 20 0 L 30 0 L 30 10 L 20 10 Z"/></g>`,
  );
  expect(svg).toContain(`<clipPath id="clip-z-${mask.id}"`);
  // The text's scale would double the Stroke, so its copy halves the width.
  expect(stroke).toMatch(/<text [^>]*transform="matrix\(2 0 0 2 0 0\)" stroke-width="2"/);
});

it.each([
  ["below", 1],
  ["above", 0],
])(
  "names one Area Type frame from the text and every paint copy, a Fill %s Contents (#112)",
  (_, contents) => {
    const { doc, defaultLayerId } = newDoc();
    const [group, text] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        appearance: {
          fills: [{ color: "#00FF00" }],
          strokes: [{ color: "#FF0000", width: 4 }],
          contents,
        },
        children: [
          {
            type: "text",
            kind: "area",
            x: 10,
            y: 10,
            width: 60,
            height: 20,
            content: "one\ntwo\nthree",
            ranges: [{ start: 0, end: 3, fill: "#0000FF" }],
          },
        ],
      },
    ]).nodes;
    if (!group || !text) throw new Error("setup");
    // Scaled by 1.25 and turned, so Open keeps the matrix instead of baking it (ADR-0017).
    doc.nodes.set(text.id, { ...text, transform: [1.2, 0.35, -0.35, 1.2, 0, 0] });
    const svg = toSvg(doc);
    const frame = `id="area-z-${text.id}"`;
    expect(svg.match(new RegExp(frame, "g"))).toHaveLength(1);
    // The text, the Fill's copy and the Stroke's copy flow in it; only the text has an id.
    expect(svg.match(new RegExp(`shape-inside:url\\(#area-z-${text.id}\\)`, "g"))).toHaveLength(3);
    expect(svg.match(new RegExp(`id="z-${text.id}"`, "g"))).toHaveLength(1);
    for (const [paint] of svg.matchAll(/<g kalamo:paint="true".*?<\/g>/g)) {
      expect(paint).not.toMatch(/<text [^>]*\bid=/);
    }
    expect(svg).toMatch(/inkscape:label="Stroke"[^>]*><text [^>]*stroke-width="3.2"/);
    // A Fill below Contents copies the text before its frame is defined; SVG resolves it either way.
    expect(svg.indexOf('inkscape:label="Fill"') < svg.indexOf(frame)).toBe(contents === 1);
    const file = parseSvg(svg);
    expect(file.warnings).toEqual([]);
    const opened = { ...doc, nodes: new Map(file.nodes.map((n) => [n.id, n])) };
    expect(JSON.parse(serializeDocument(opened))).toEqual(JSON.parse(serializeDocument(doc)));
  },
);

it("writes a container gradient in its paint group's <defs>, and a turned text copy's own copy of it (#107)", () => {
  const { doc, defaultLayerId } = newDoc();
  const stops = [
    { offset: 0, color: "#000000" },
    { offset: 1, color: "#FFFFFF" },
  ];
  const [group, , plain, turned] = createNodes(doc, [
    {
      type: "group",
      parentId: defaultLayerId,
      appearance: {
        fills: [
          {
            type: "gradient",
            gradient: { type: "linear", stops, start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
          },
        ],
        strokes: [
          {
            type: "gradient",
            width: 2,
            gradient: {
              type: "radial",
              stops,
              center: { x: 50, y: 50 },
              radius: 40,
              aspectRatio: 0.5,
            },
          },
        ],
      },
      children: [
        { type: "rect", x: 0, y: 0, width: 10, height: 10 },
        { type: "text", x: 10, y: 50, content: "Hi" },
        { type: "text", x: 10, y: 50, content: "Ho" },
      ],
    },
  ]).nodes;
  if (!group || !plain || !turned) throw new Error("setup");
  doc.nodes.set(turned.id, { ...turned, transform: [2, 0, 0, 2, 0, 0] });
  const svg = toSvg(doc);
  const fill = `fill-0-z-${group.id}`;
  expect(svg).toContain(
    `<defs><linearGradient id="${fill}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">`,
  );
  // The shape and the text in document coordinates paint with the group's gradient.
  expect(svg).toMatch(
    /<\/defs><g [^>]*inkscape:label="Fill" fill="url\(#fill-0-[^"]*"><path d="M 0 0 L 10 0/,
  );
  expect(svg.match(new RegExp(`${fill}-${plain.id}`))).toBeNull();
  // SVG reads userSpaceOnUse in the text's own space, so its copy is the field halved.
  expect(svg).toContain(
    `<linearGradient id="${fill}-${turned.id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="50" y2="0">`,
  );
  expect(svg).toMatch(
    new RegExp(
      `<text [^>]*transform="matrix\\(2 0 0 2 0 0\\)"[^>]*style="fill:url\\(#${fill}-${turned.id}\\)`,
    ),
  );
  const stroke = `stroke-0-z-${group.id}`;
  expect(svg).toContain(`inkscape:label="Stroke" fill="none" stroke="url(#${stroke})"`);
  expect(svg).toContain(`<radialGradient id="${stroke}-${turned.id}"`);
  expect(svg).toMatch(new RegExp(`style="stroke:url\\(#${stroke}-${turned.id}\\)`));
});

it("writes every isolated kind, far and near, byte for byte as before render's band (ADR-0055)", async () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const fill = { fills: [{ color: "#FF0000" }] };
  const [outer, , inner] = createNodes(doc, [
    {
      type: "group",
      parentId,
      children: [
        { type: "rect", x: -500, y: 10, width: 520, height: 20 },
        { type: "group", children: [{ type: "rect", x: 30, y: -900, width: 20, height: 920 }] },
        { type: "rect", x: 30, y: 30, width: 20, height: 20, appearance: fill },
      ],
    },
  ]).nodes as ShapeNode[];
  updateNodes(doc, [
    { nodeId: outer?.id ?? "", patch: { opacity: 0.5 } },
    { nodeId: inner?.id ?? "", patch: { blendMode: "multiply" } },
  ]);
  const [content, clip, far, near] = createNodes(doc, [
    { type: "rect", parentId, x: -1000, y: 0, width: 1050, height: 10 },
    { type: "ellipse", parentId, x: 5, y: 5, width: 40, height: 40 },
    { type: "rect", parentId, x: 1000, y: 0, width: 10, height: 10 },
    { type: "rect", parentId, x: 40, y: 40, width: 10, height: 10 },
  ]).nodes as ShapeNode[];
  const { group } = makeMask(doc, { clipNodeId: clip?.id ?? "", contentIds: [content?.id ?? ""] });
  updateNodes(doc, [
    { nodeId: clip?.id ?? "", patch: { appearance: { strokes: [{ color: "#00FF00" }] } } },
    { nodeId: group.id, patch: { appearance: { fills: [{ color: "#0000FF" }], contents: 1 } } },
    { nodeId: far?.id ?? "", patch: { opacity: 0.5 } },
    { nodeId: near?.id ?? "", patch: { blendMode: "screen" } },
  ]);
  const [layer] = createNodes(doc, [{ type: "layer" }]).nodes as [ShapeNode];
  createNodes(doc, [
    { type: "rect", parentId: layer.id, x: -800, y: -800, width: 900, height: 900 },
    { type: "ellipse", parentId: layer.id, x: 0, y: 0, width: 100, height: 100 },
  ]);
  makeMask(doc, { layerId: layer.id });
  const [painter, , masked, circle] = createNodes(doc, [
    {
      type: "group",
      parentId,
      appearance: { fills: [{ color: "#00FF00" }] },
      children: [
        { type: "rect", x: 60, y: 60, width: 10, height: 10 },
        { type: "rect", x: -900, y: 0, width: 920, height: 10 },
        { type: "ellipse", x: 0, y: 0, width: 30, height: 30 },
      ],
    },
  ]).nodes as ShapeNode[];
  makeMask(doc, { clipNodeId: circle?.id ?? "", contentIds: [masked?.id ?? ""] });
  updateNodes(doc, [{ nodeId: painter?.id ?? "", patch: { opacity: 0.5 } }]);
  // Node ids are random: each is numbered in the order it first appears.
  const ids = new Map<string, number>();
  const svg = toSvg(doc).replace(/[0-9A-HJKMNP-TV-Z]{26}/g, (id) => {
    if (!ids.has(id)) ids.set(id, ids.size);
    return `N${ids.get(id)}`;
  });
  await expect(svg).toMatchFileSnapshot("__snapshots__/isolated-kinds.svg");
});

describe("a space after a character in another bundled family (ADR-0067)", () => {
  const exported = (content: string, extra: object = {}) => {
    const { doc, defaultLayerId: parentId } = newDoc();
    const [node] = createNodes(doc, [
      { type: "text", parentId, x: 0, y: 20, content, ...extra },
    ]).nodes;
    if (node?.type !== "text") throw new Error("setup");
    return { doc, node, svg: toSvg(doc) };
  };
  // Each line tspan's content, up to the next line tspan or the text's end.
  const lines = (svg: string) =>
    [
      ...svg.matchAll(
        /<tspan (?:sodipodi:role="line" )?x="[^"]*" y="[^"]*">(.*?)<\/tspan>(?=<tspan (?:sodipodi|x)|<\/text>)/g,
      ),
    ].map((m) => m[1]);

  it("writes each run of spaces after Hangul as its own tspan, and not one after Latin", () => {
    expect(lines(exported("Hi 한국 어  Kalamo").svg)).toEqual([
      `Hi <tspan style="line-height:0.948">한국</tspan><tspan> </tspan><tspan style="line-height:0.948">어</tspan><tspan>  </tspan>Kalamo`,
    ]);
  });

  it("does the same in Area Type, and for a no-break space after Han", () => {
    const { svg } = exported("Hi 한국 어 Kalamo 小 x", {
      kind: "area",
      width: 200,
      height: 80,
    });
    expect(lines(svg)).toEqual([
      `Hi <tspan style="line-height:0.948">한국</tspan><tspan> </tspan><tspan style="line-height:0.948">어</tspan><tspan> </tspan>Kalamo <tspan style="line-height:0.948">小</tspan><tspan> </tspan>x`,
    ]);
  });

  it("decides by family, not advance: a Hangul space in a Noto Sans SC text is split", () => {
    const { svg } = exported("小 한 x", { fontFamily: "Noto Sans SC" });
    expect(lines(svg)).toEqual(["小 한<tspan> </tspan>x"]);
  });

  it("keeps a Latin-only text and a space at a line's start as they were", () => {
    expect(lines(exported("Hi there\n 한").svg)).toEqual([
      "Hi there",
      ` <tspan style="line-height:0.948">한</tspan>`,
    ]);
  });

  it("keeps a space's Character Range attributes in its own tspan", () => {
    const { svg } = exported("한 국", { ranges: [{ start: 0, end: 3, fill: "#FF0000" }] });
    expect(lines(svg)).toEqual([
      `<tspan fill="#FF0000" style="line-height:0.948">한</tspan><tspan fill="#FF0000"> </tspan><tspan fill="#FF0000" style="line-height:0.948">국</tspan>`,
    ]);
  });

  it.each(["Point", "Area"])("Opens the export of %s Type as the same Node", (kind) => {
    const { node, svg } = exported("Hi 한국 어 Kalamo", {
      ...(kind === "Area" && { kind: "area", width: 200, height: 80 }),
      ranges: [{ start: 5, end: 7, fill: "#FF0000" }],
    });
    const file = parseSvg(svg);
    expect(file.warnings).toEqual([]);
    expect(file.nodes.find((n) => n.id === node.id)).toEqual(node);
  });

  it("leaves resvg's chunked SVG without the split", () => {
    const { doc } = exported("한 x");
    expect(toSvg(doc, undefined, { resvg: true })).not.toContain("<tspan> </tspan>");
  });
});

it.each([
  ["Point", { x: 10, y: 30 }],
  ["Area", { kind: "area", x: 10, y: 30, width: 200, height: 120 }],
  ["shaped Area", { kind: "area", frame: "M 10 10 L 210 10 L 210 130 L 110 160 L 10 130 Z" }],
])(
  "writes a fallback run's line-height, so Inkscape stacks %s Type by leading alone, and Opens it back (ADR-0080)",
  (_, extra) => {
    const { doc, defaultLayerId: parentId } = newDoc();
    const text = (content: string, more: object) =>
      createNodes(doc, [
        { type: "text", parentId, fontSize: 20, content, ...extra, ...more } as never,
      ]).nodes[0] as Node;
    const nodes = [
      // Auto: 1.2 less twice what Noto Sans SC's ascent, 0.88, exceeds Source Sans 3's, 1000 / 1326.
      text("Hi 中文\nnext", {}),
      // A set leading, at the run's own size: 30 − 0.251704 × 30, rounded down.
      text("Hi 中文\nnext", { leading: 30, ranges: [{ start: 3, end: 5, fontSize: 30 }] }),
      // Source Sans 3 in a Noto Sans SC text drops below its box by as much.
      text("中文 Hi", {
        fontFamily: "Noto Sans SC",
        ranges: [{ start: 3, end: 5, fontFamily: "Source Sans 3" }],
      }),
      text("Latin only\nnext", {}),
    ];
    const svg = toSvg(doc);
    expect(svg).toContain('<tspan style="line-height:0.948">中文</tspan>');
    expect(svg).toContain('<tspan font-size="30" style="line-height:22.448px">中文</tspan>');
    expect(svg).toContain(
      '<tspan font-family="Source Sans 3" style="line-height:0.948">Hi</tspan>',
    );
    // Only those three runs: no line tspan, and nothing in the Latin-only text, gets one.
    expect(svg.match(/<tspan[^>]*line-height/g)).toHaveLength(3);
    const file = parseSvg(svg);
    expect(file.warnings).toEqual([]);
    for (const n of nodes) expect(file.nodes.find((m) => m.id === n.id)).toEqual(n);
  },
);

it.each([
  ["Point", {}],
  ["Area", { kind: "area", width: 70, height: 80 }],
])(
  "exports %s Type converted to the other kind in that kind's form, and Opens it back (ADR-0079)",
  (_, extra) => {
    const { doc, defaultLayerId: parentId } = newDoc();
    const [t] = createNodes(doc, [
      {
        type: "text",
        parentId,
        x: 10,
        y: 20,
        content: "Converted words wrap\nor break",
        tracking: 20,
        ranges: [{ start: 2, end: 9, fill: "#FF0000" }],
        ...extra,
      } as never,
    ]).nodes as [Node];
    const kind = t.type === "text" && t.kind === "area" ? "point" : "area";
    const [node] = updateNodes(doc, [{ nodeId: t.id, patch: { kind } }]).nodes as [Node];
    const svg = toSvg(doc);
    expect(svg.includes(`shape-inside:url(#area-z-${t.id})`)).toBe(kind === "area");
    const file = parseSvg(svg);
    expect(file.warnings).toEqual([]);
    expect(file.nodes.find((n) => n.id === t.id)).toEqual(node);
  },
);
