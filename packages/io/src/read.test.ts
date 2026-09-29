import {
  childrenOf,
  createDocument,
  createNodes,
  type Fill,
  type ImageNode,
  KalamoError,
  LEGACY_NAME,
  LEGACY_SVG_NS,
  type Matrix,
  makeMask,
  type Node,
  normalizePath,
  readImage,
  type ShapeNode,
  serializeDocument,
  shapeSegments,
  transformNodes,
} from "@kalamo/core";
import { describe, expect, it } from "vitest";
import kalamoExport from "../../../fixtures/documents/inkscape.svg?raw";
import { RED_2x2_PNG, WEBP_HEADER } from "../../../fixtures/images.ts";
import reference from "../../core/src/spiral.inkscape.json" with { type: "json" };
import { NS as DIALECT_NS } from "./dialect.ts";
import { MAX_DEPTH, parseFile, parseSvg, resolveLinks, SVG_LIMIT, toSvg } from "./index.ts";

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof KalamoError) return e.data;
    throw e;
  }
  throw new Error("expected a KalamoError");
};

const NS = [
  'xmlns="http://www.w3.org/2000/svg"',
  'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"',
  'xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"',
  `xmlns:kalamo="${DIALECT_NS.kalamo}"`,
].join(" ");
const svg = (attrs: string, body = "") => `<svg ${NS} ${attrs}>${body}</svg>`;

it("opens .kalamo.json text as core reads it, detected by content", () => {
  const file = parseFile(
    `﻿  ${JSON.stringify({
      version: 1,
      name: "J",
      artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, width: 10, height: 10 } }],
      nodes: [
        {
          id: "l",
          type: "layer",
          name: "L",
          parentId: null,
          index: "a0",
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: "normal",
          transform: [1, 0, 0, 1, 0, 0],
          tags: [],
          meta: {},
        },
      ],
    })}`,
  );
  expect(file).toMatchObject({ name: "J", warnings: [] });
  expect(file.nodes.map((n) => n.id)).toEqual(["l"]);
});

it.each([
  ["hello", "not an SVG or .kalamo.json file"],
  ["<svg><g></svg>", "mismatch"],
  ["<html/>", "<svg>"],
  [`<!DOCTYPE svg [<!ENTITY a "x"><!ENTITY b "&a;&a;">]>${svg("", "<text>&a;&b;</text>")}`, "&b;"],
  [`<!DOCTYPE svg [<!ENTITY n "&a;"><!ENTITY n "plain">]>${svg("", "<text>&n;</text>")}`, "&n;"],
  [`<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${svg("", "<text>&x;</text>")}`, "&x;"],
  [
    `<!DOCTYPE svg [<!ENTITY % p "<!ENTITY q 'Q'>"> %p; <!ENTITY y "Y">]>${svg("", "<text>&y;</text>")}`,
    "&y;",
  ],
])("refuses %j as INVALID_DOCUMENT", (content, message) => {
  expect(errorOf(() => parseFile(content))).toMatchObject({
    code: "INVALID_DOCUMENT",
    path: "content",
    message: expect.stringContaining(message),
  });
});

// Saved by Illustrator's legacy SVG Export Plug-In with Preserve Illustrator Editing Capabilities
// and Style Attributes (Entity References).
const ILLUSTRATOR = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 16.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
	<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">
	<!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">
	<!ENTITY ns_graphs "http://ns.adobe.com/Graphs/1.0/">
	<!ENTITY ns_vars "http://ns.adobe.com/Variables/1.0/">
	<!ENTITY ns_imrep "http://ns.adobe.com/ImageReplacement/1.0/">
	<!ENTITY ns_sfw "http://ns.adobe.com/SaveForWeb/1.0/">
	<!ENTITY ns_custom "http://ns.adobe.com/GenericCustomNamespace/1.0/">
	<!ENTITY ns_adobe_xpath "http://ns.adobe.com/XPath/1.0/">
	<!ENTITY ns_svg "http://www.w3.org/2000/svg">
	<!ENTITY ns_xlink "http://www.w3.org/1999/xlink">
	<!ENTITY st0 "fill:none;stroke:#333333;stroke-miterlimit:10;">
	<!ENTITY st1 "font-family:'MyriadPro-Regular';font-size:12;">
]>
<svg version="1.1" id="Layer_1" xmlns:x="&ns_extend;" xmlns:i="&ns_ai;" xmlns:graph="&ns_graphs;"
	 xmlns="&ns_svg;" xmlns:xlink="&ns_xlink;" x="0px" y="0px" width="200px" height="100px"
	 viewBox="0 0 200 100" enable-background="new 0 0 200 100" xml:space="preserve">
<metadata>
	<sfw  xmlns="&ns_sfw;">
		<slices></slices>
		<sliceSourceBounds  width="80" height="70" y="10" x="10" bottomLeftOrigin="true"></sliceSourceBounds>
	</sfw>
</metadata>
<switch>
	<foreignObject requiredExtensions="&ns_ai;" x="0" y="0" width="1" height="1">
		<i:pgfRef  xlink:href="#adobe_illustrator_pgf">
		</i:pgfRef>
	</foreignObject>
	<g i:extraneous="self">
		<rect x="10" y="10" style="&st0;" width="80" height="40"/>
		<text transform="matrix(1 0 0 1 20 80)" style="&st1;">Hello</text>
	</g>
</switch>
<i:pgf  id="adobe_illustrator_pgf">
	<![CDATA[
	eJzsvVmTHUeSLvbcZvwPpQfZiGbDbnFlvhOSm2dnKqQ&st0;
	]]>
</i:pgf>
</svg>
`;

it("opens Illustrator's legacy SVG, its namespaces and styles declared as DTD entities", () => {
  const file = parseFile(ILLUSTRATOR);
  const [rect, text] = leaves(file);
  expect(rect).toMatchObject({
    type: "rect",
    appearance: {
      fills: [],
      strokes: [{ color: "#333333", width: 1, miterLimit: 10 }],
    },
  });
  expect(text).toMatchObject({
    type: "text",
    content: "Hello",
    fontFamily: "MyriadPro-Regular",
    fontSize: 12,
  });
  expect(file.warnings.map((w) => w.code)).toEqual(["FONT_MISSING"]);
});

it.each([`"`, `'`])("expands an entity with quotes inside a %s-quoted attribute", (q) => {
  const file = parseFile(
    `<!DOCTYPE svg [<!ENTITY f "font-family:'A B';"><!ENTITY t 'say "hi"'>]>` +
      svg("", `<text style=${q}&f;${q} data-t=${q}&t;${q}>&t;</text>`),
  );
  expect(leaves(file)[0]).toMatchObject({ fontFamily: "A B", content: 'say "hi"' });
});

it("keeps the predefined entities, the first declaration, and CDATA and comments as written", () => {
  const file = parseFile(
    `<!DOCTYPE svg [<!ENTITY amp "X"><!ENTITY lt "Y"><!ENTITY e "one"><!ENTITY e "two">]>` +
      svg("", "<text>&amp;&lt;&e;<!-- &e; --><?p &e;?><![CDATA[&e;]]></text>"),
  );
  expect(leaves(file)[0]).toMatchObject({ content: "&<one&e;" });
  const boom = parseFile(`<!DOCTYPE svg [<!ENTITY xxe "BOOM">]>${svg("", "<text>&xxe;</text>")}`);
  expect(leaves(boom)[0]).toMatchObject({ content: "BOOM" });
});

it.each([
  [
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
  ],
  ['<!DOCTYPE svg [<!ATTLIST svg a CDATA "&amp;"><!ELEMENT svg ANY>]>'],
])("reads %s as before", (doctype) => {
  const body = '<rect width="1" height="1"/><text>&amp;</text>';
  const withoutIds = (file: ReturnType<typeof parseFile>) =>
    file.nodes.map(({ id, parentId, index, ...rest }) => rest);
  expect(withoutIds(parseFile(doctype + svg("", body)))).toEqual(
    withoutIds(parseFile(svg("", body))),
  );
});

it("refuses entities that expand past 5 MB before building the text", () => {
  const mb = "x".repeat(1024 * 1024);
  const content = `<!DOCTYPE svg [<!ENTITY big "${mb}">]>${svg("", `<desc>${"&big;".repeat(6)}</desc>`)}`;
  expect(errorOf(() => parseFile(content))).toMatchObject({
    code: "LIMIT_EXCEEDED",
    path: "content",
    message: expect.stringContaining("&big;"),
    hint: expect.stringContaining("Entity References"),
  });
  expect(leaves(parseFile(content.replace("&big;".repeat(6), "&big;".repeat(4))))).toEqual([]);
});

it("never reads an external entity into the error", () => {
  const data = errorOf(() =>
    parseFile(
      `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${svg("", "<text>&x;</text>")}`,
    ),
  );
  expect(JSON.stringify(data)).not.toMatch(/root:/);
});

it("refuses an SVG over 5 MB before parsing it", () => {
  const big = svg("", `<desc>${"x".repeat(SVG_LIMIT)}</desc>`);
  expect(errorOf(() => parseFile(big))).toMatchObject({
    code: "LIMIT_EXCEEDED",
    path: "content",
    message: expect.not.stringContaining("Open"),
  });
});

it("makes one Artboard from the root's size in pt, and one empty Layer", () => {
  const file = parseFile(svg('width="210mm" height="297mm" viewBox="0 0 210 297"'));
  expect(file.name).toBe("Untitled");
  expect(file.artboards).toEqual([
    {
      id: expect.any(String),
      name: "Artboard 1",
      frame: { x: 0, y: 0, width: 595.276, height: 841.89 },
    },
  ]);
  expect(file.nodes).toMatchObject([{ type: "layer", name: "Layer 1", parentId: null }]);
  // A px or unitless length is one pt, as Illustrator opens it.
  const px = parseFile(svg('width="300px" height="200"', "<title>T</title>"));
  expect(px.name).toBe("T");
  expect(px.artboards[0]?.frame).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  expect(parseFile(svg('viewBox="10 20 30 40"')).artboards[0]?.frame).toEqual({
    x: 10,
    y: 20,
    width: 30,
    height: 40,
  });
  expect(parseFile(svg('width="10in" height="1in"'), { name: "Hint" }).name).toBe("Hint");
});

it("never runs or keeps a script or an event attribute", () => {
  const file = parseFile(
    svg('width="10" height="10" onload="alert(1)"', "<script>alert(2)</script>"),
  );
  expect(
    serializeDocument({
      id: "",
      version: 1,
      rev: 0,
      ...file,
      nodes: new Map(file.nodes.map((n) => [n.id, n])),
    }),
  ).not.toMatch(/alert/);
});

/** The Nodes of a file by parent, each as the fields a test names. */
const byParent = (file: ReturnType<typeof parseFile>, parentId: string | null) =>
  file.nodes.filter((n) => n.parentId === parentId).sort((a, b) => (a.index < b.index ? -1 : 1));

it("reads every shape element into a Live Shape or Path, in one Layer, in document order", () => {
  const file = parseFile(
    svg(
      'width="100" height="100" viewBox="0 0 100 100"',
      '<rect id="path123" x="1" y="2" width="3" height="4" rx="1"/>' +
        '<g transform="translate(10,20)"><circle cx="5" cy="5" r="5"/>' +
        '<path d="m 0 0 l 10 0 a 5 5 0 0 1 -10 0 z" transform="rotate(90)"/></g>' +
        '<polygon points="0,0 10,0 5,8"/><polyline points="0 0 5 5"/>' +
        '<line x1="0" y1="0" x2="3" y2="4"/><ellipse cx="50" cy="50" rx="10" ry="5"/>' +
        '<rect id="z-01M38T29SBZ873XP2NBD2K6CYR" x="0" y="0" width="10" height="10"/>',
    ),
  );
  const [layer, ...rest] = byParent(file, null);
  expect(rest).toEqual([]);
  expect(layer).toMatchObject({ type: "layer", name: "Layer 1" });
  const kids = byParent(file, layer?.id ?? "");
  expect(kids.map((n) => [n.type, n.index])).toEqual([
    ["rect", "a0"],
    ["group", "a1"],
    ["path", "a2"],
    ["path", "a3"],
    ["line", "a4"],
    ["ellipse", "a5"],
    ["rect", "a6"],
  ]);
  const [rect, group, polygon, polyline, line, ellipse, kept] = kids;
  expect(rect?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(rect).toMatchObject({ x: 1, y: 2, width: 3, height: 4, radius: 1 });
  expect(kept?.id).toBe("01M38T29SBZ873XP2NBD2K6CYR");
  expect(polygon).toMatchObject({ d: "M 0 0 L 10 0 L 5 8 Z" });
  expect(polyline).toMatchObject({ d: "M 0 0 L 5 5" });
  expect(line).toMatchObject({ x1: 0, y1: 0, x2: 3, y2: 4 });
  expect(ellipse).toMatchObject({ x: 40, y: 45, width: 20, height: 10 });
  // A move bakes into the parameters; a turn stays a matrix, the Group's included (ADR-0007).
  const [circle, turned] = byParent(file, group?.id ?? "");
  expect(group?.transform).toEqual([1, 0, 0, 1, 0, 0]);
  expect(circle).toMatchObject({
    type: "ellipse",
    x: 10,
    y: 20,
    width: 10,
    height: 10,
    transform: [1, 0, 0, 1, 0, 0],
  });
  expect(turned?.transform).toEqual([0, 1, -1, 0, 10, 20]);
  expect(turned?.type === "path" && turned.d).toMatch(/^M 0 0 L 10 0( C [-\d. ]+)+ Z$/);
});

it("scales user units to pt into the parameters, and keeps a skew as a matrix", () => {
  const file = parseFile(
    svg(
      'width="200" height="200" viewBox="0 0 100 100"',
      '<rect x="1" y="2" width="3" height="4" rx="1"/>' +
        '<rect x="1" y="2" width="3" height="4" transform="skewX(45)"/>' +
        '<g transform="matrix(1 0 0 1 5 0) scale(2)"><line x1="0" y1="0" x2="1" y2="1"/></g>',
    ),
  );
  const [layer] = byParent(file, null);
  const [scaled, skewed, group] = byParent(file, layer?.id ?? "");
  expect(scaled).toMatchObject({ x: 2, y: 4, width: 6, height: 8, radius: 2 });
  expect(skewed).toMatchObject({ x: 1, y: 2, width: 3, height: 4, transform: [2, 0, 2, 2, 0, 0] });
  expect(byParent(file, group?.id ?? "")[0]).toMatchObject({ x1: 10, y1: 0, x2: 14, y2: 4 });
});

it("gives a second element with the same z- id a new id", () => {
  const id = "z-01M38T29SBZ873XP2NBD2K6CYR";
  const file = parseFile(
    svg("", `<rect id="${id}" width="1" height="1"/><rect id="${id}" width="1" height="1"/>`),
  );
  const ids = file.nodes.filter((n) => n.type === "rect").map((n) => n.id);
  expect(ids[0]).toBe(id.slice(2));
  expect(ids[1]).not.toBe(id.slice(2));
});

/** The leaves of a file, in document order. */
const leaves = (file: ReturnType<typeof parseFile>) =>
  file.nodes.filter((n) => n.type !== "layer" && n.type !== "group");

it("resolves presentation attributes, <style> classes, style and inheritance into Appearance", () => {
  const file = parseFile(
    svg(
      'width="100" height="100"',
      "<style>/* c */ .a{fill:rgb(255,0,0);stroke:#00f} rect.b, .c{fill:#111}</style>" +
        '<rect class="a" fill="blue" style="stroke:yellow" width="1" height="1"/>' +
        '<g fill="green" fill-opacity=".5" color="#0f0"><path d="M 0 0 L 1 1"/>' +
        '<rect fill="currentColor" width="1" height="1"/></g>' +
        '<rect style="fill:none;stroke:#000;stroke-width:1mm;stroke-linejoin:round;display:none;opacity:.6;mix-blend-mode:multiply" width="1" height="1"/>' +
        '<rect stroke="#000" stroke-opacity="50%" stroke-dasharray="1,2,3" stroke-linecap="round" width="1" height="1"/>' +
        '<defs><linearGradient id="g" href="#h"/><linearGradient id="h"><stop offset="0" style="stop-color:#123456;stop-opacity:1"/></linearGradient></defs>' +
        '<rect fill="url(#g)" width="1" height="1"/><rect fill="url(#nope)" stroke="none" width="1" height="1"/>',
    ),
  );
  const [classed, inGroup, current, styled, stroked, gradient, missing] = leaves(file);
  const look = (n: (typeof file.nodes)[number] | undefined) =>
    n && "appearance" in n ? n.appearance : undefined;
  expect(look(classed)).toMatchObject({
    fills: [{ color: "#FF0000" }],
    strokes: [{ color: "#FFFF00", width: 1, cap: "butt", join: "miter", miterLimit: 4, dash: [] }],
  });
  expect(look(inGroup)).toEqual({ fills: [{ type: "solid", color: "#00800080" }], strokes: [] });
  expect(look(current)?.fills).toEqual([{ type: "solid", color: "#00FF0080" }]);
  expect(styled).toMatchObject({ visible: false, opacity: 0.6, blendMode: "multiply" });
  expect(look(styled)).toMatchObject({
    fills: [],
    strokes: [{ width: 2.835, join: "round", miterLimit: 10 }],
  });
  expect(look(stroked)?.strokes).toEqual([
    {
      type: "solid",
      color: "#00000080",
      width: 1,
      cap: "round",
      join: "miter",
      miterLimit: 4,
      dash: [1, 2, 3, 1, 2, 3],
    },
  ]);
  expect(look(gradient)?.fills).toEqual([{ type: "solid", color: "#123456" }]);
  expect(look(missing)).toEqual({ fills: [], strokes: [] });
  // One stop is a solid paint, as SVG draws it and Inkscape stores a solid Swatch.
  expect(file.warnings.map((w) => w.code)).toEqual(["UNSUPPORTED_PAINT"]);
});

it("scales Stroke widths and dashes with the user unit", () => {
  const file = parseFile(
    svg(
      'width="20mm" height="10mm" viewBox="0 0 20 10"',
      '<line x2="10" stroke="#000" stroke-width=".5" stroke-dasharray="2 1"/>',
    ),
  );
  expect(leaves(file)[0]).toMatchObject({
    x2: 28.346,
    appearance: { strokes: [{ width: 1.417, dash: [5.669, 2.835] }] },
  });
});

it("reads Inkscape layers, labels, locks and pages, and Kalamo's tags, meta, stacks and backgrounds", () => {
  const kept = "01M38T29S8GTJN2S1004N4Q1BH";
  const file = parseFile(
    svg(
      'width="100mm" height="50mm" viewBox="0 0 100 50" sodipodi:docname="two pages.svg"',
      '<sodipodi:namedview inkscape:document-units="mm">' +
        `<inkscape:page x="0" y="0" width="100" height="50" id="z-${kept}" inkscape:label="Front"/>` +
        '<inkscape:page x="110" y="0" width="20" height="20" id="page2"/></sodipodi:namedview>' +
        `<rect width="100" height="50" fill="#FFF4D6" kalamo:artboard="${kept}" sodipodi:insensitive="true"/>` +
        '<rect width="100" height="50" fill="#FFF4D6" kalamo:artboard="01M38T29S9V6NZ3YY4ARKXBP1G"/>' +
        '<rect width="100" height="50" fill="#000000" kalamo:background="true"/>' +
        '<g inkscape:groupmode="layer" inkscape:label="Top" transform="translate(5,5)" sodipodi:insensitive="1" style="display:none">' +
        '<g inkscape:groupmode="layer" inkscape:label="Inner"><path d="M 0 0 L 1 0"/></g>' +
        `<g kalamo:stack="true" kalamo:tags='["a"]' kalamo:meta='{"k":1}' inkscape:label="Stack" style="opacity:0.5">` +
        '<path d="M 0 0 L 1 1" fill="#FF0000"/><path d="M 0 0 L 1 1" fill="#00FF00"/>' +
        '<path d="M 0 0 L 1 1" fill="none" stroke="#0000FF"/></g></g>',
    ),
  );
  expect(file.name).toBe("two pages");
  expect(file.artboards).toEqual([
    {
      id: kept,
      name: "Front",
      frame: { x: 0, y: 0, width: 283.465, height: 141.732 },
      background: "#FFF4D6",
    },
    {
      id: expect.not.stringMatching(/page2/),
      name: "Artboard 2",
      frame: { x: 311.811, y: 0, width: 56.693, height: 56.693 },
    },
  ]);
  expect(file.nodes.filter((n) => n.type === "rect")).toEqual([]);
  const [top, ...others] = byParent(file, null);
  expect(others).toEqual([]);
  expect(top).toMatchObject({ type: "layer", name: "Top", visible: false, locked: true });
  const [inner, stack] = byParent(file, top?.id ?? "");
  expect(inner).toMatchObject({ type: "layer", name: "Inner", visible: true, locked: false });
  expect(byParent(file, inner?.id ?? "")[0]).toMatchObject({
    d: "M 14.173 14.173 L 17.008 14.173",
  });
  expect(stack).toMatchObject({
    type: "path",
    name: "Stack",
    opacity: 0.5,
    tags: ["a"],
    meta: { k: 1 },
    d: "M 14.173 14.173 L 17.008 17.008",
    appearance: {
      fills: [{ color: "#FF0000" }, { color: "#00FF00" }],
      strokes: [{ color: "#0000FF", width: 2.835 }],
    },
  });
});

it("warns about tags or meta that are not JSON, and drops them", () => {
  const file = parseFile(
    svg("", `<rect width="1" height="1" kalamo:tags="nope" kalamo:meta='[1]'/>`),
  );
  expect(leaves(file)[0]).toMatchObject({ tags: [], meta: {} });
  expect(file.warnings.map((w) => w.code)).toEqual(["INVALID_TAGS_META"]);
});

const star = (attrs: Record<string, string | number>) =>
  `<path ${Object.entries({
    "sodipodi:type": "star",
    "sodipodi:sides": 5,
    "sodipodi:cx": 260,
    "sodipodi:cy": 150,
    "sodipodi:r1": 35,
    "sodipodi:r2": 15,
    "sodipodi:arg1": -Math.PI / 2,
    "sodipodi:arg2": -Math.PI / 2 + Math.PI / 5,
    "inkscape:flatsided": "false",
    "inkscape:rounded": 0,
    "inkscape:randomized": 0,
    d: "M 260 115 L 270 140 L 250 140 Z",
    ...attrs,
  })
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}/>`;

it("reads Inkscape stars and polygons back as Live Shapes, a turned one with its angle", () => {
  const file = parseFile(
    svg(
      'width="400" height="300"',
      star({}) +
        star({
          "inkscape:flatsided": "true",
          "sodipodi:sides": 6,
          "sodipodi:r1": 30,
          "sodipodi:r2": 25.981,
        }) +
        star({ "sodipodi:arg1": 0, "sodipodi:arg2": Math.PI / 5 }),
    ),
  );
  const [five, six, turned] = leaves(file);
  expect(five).toMatchObject({
    type: "star",
    cx: 260,
    cy: 150,
    outerRadius: 35,
    innerRadius: 15,
    points: 5,
    transform: [1, 0, 0, 1, 0, 0],
  });
  expect(six).toMatchObject({ type: "polygon", cx: 260, cy: 150, radius: 30, sides: 6 });
  expect(turned).toMatchObject({
    type: "star",
    cx: 260,
    cy: 150,
    angle: 90,
    twist: 0,
    transform: [1, 0, 0, 1, 0, 0],
  });
  expect(file.warnings).toEqual([]);
});

it("reads rounded, twisted and randomized stars as Live Shapes, and an arc as an ellipse", () => {
  const file = parseFile(
    svg(
      'width="400" height="300"',
      star({ "inkscape:rounded": 0.2 }) +
        star({ "sodipodi:arg2": -Math.PI / 2 + Math.PI / 5 + 0.1 }) +
        // arg2 past -π: the twist is still 0.1 rad.
        star({ "sodipodi:arg1": 3, "sodipodi:arg2": 3 + Math.PI / 5 + 0.1 - 2 * Math.PI }) +
        '<path sodipodi:type="arc" sodipodi:cx="5" sodipodi:cy="5" sodipodi:rx="5" sodipodi:ry="5" sodipodi:start="0" sodipodi:end="3" sodipodi:arc-type="slice" d="M 10 5 A 5 5 0 0 1 0 5 L 5 5 Z"/>',
    ),
  );
  const [rounded, twisted, wrapped, arc] = leaves(file);
  expect(rounded).toMatchObject({ type: "star", rounded: 0.2, twist: 0, randomized: 0 });
  expect(twisted).toMatchObject({ type: "star", twist: 5.73, angle: 0 });
  expect(wrapped).toMatchObject({ type: "star", twist: 5.73, angle: 261.887 });
  expect(arc).toMatchObject({
    type: "ellipse",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    startAngle: 0,
    endAngle: 171.887,
    arcType: "slice",
  });
  expect(file.warnings).toEqual([]);
});

/** An arc as Inkscape 1.2.2 writes it; its d is ignored, since Inkscape draws the parameters too. */
const arc = (attrs: Record<string, string | number>) =>
  `<path ${Object.entries({
    "sodipodi:type": "arc",
    "sodipodi:cx": 100,
    "sodipodi:cy": 80,
    "sodipodi:rx": 60,
    "sodipodi:ry": 30,
    "sodipodi:start": 0,
    "sodipodi:end": 4.71238898038469,
    ...attrs,
  })
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")} d="M 0 0 Z"/>`;

it("opens an Inkscape arc of each type as an ellipse with the same angles and type (ADR-0025)", () => {
  const cases: [Record<string, string | number>, object][] = [
    [{ "sodipodi:arc-type": "slice" }, { startAngle: 0, endAngle: 270, arcType: "slice" }],
    [
      { "sodipodi:arc-type": "chord", "sodipodi:open": "true" },
      { endAngle: 270, arcType: "chord" },
    ],
    [
      { "sodipodi:arc-type": "arc", "sodipodi:open": "true" },
      { endAngle: 270, arcType: "open" },
    ],
    // Before arc-type, sodipodi:open alone made an open arc; an unknown type is a slice.
    [{}, { arcType: "slice" }],
    [{ "sodipodi:open": "true" }, { arcType: "open" }],
    [{ "sodipodi:arc-type": "foo", "sodipodi:open": "true" }, { arcType: "slice" }],
    // Angles in any turn come back within one, an end before the start wrapping through 0°.
    [
      { "sodipodi:start": -1, "sodipodi:end": 8 },
      { startAngle: 302.704, endAngle: 98.366 },
    ],
    [
      { "sodipodi:start": 5.5, "sodipodi:end": 0.5 },
      { startAngle: 315.127, endAngle: 28.648 },
    ],
    [
      { "sodipodi:start": 1, "sodipodi:end": 1, "sodipodi:arc-type": "chord" },
      { startAngle: 57.296, endAngle: 57.296, arcType: "chord" },
    ],
    [
      { "sodipodi:end": 2 * Math.PI, "sodipodi:arc-type": "arc" },
      { startAngle: 0, endAngle: 360, arcType: "open" },
    ],
    // Inkscape's own writer, after a move, keeps about 8 digits.
    [{ "sodipodi:end": 4.712389 }, { endAngle: 270 }],
  ];
  for (const [attrs, want] of cases) {
    const file = parseFile(svg('width="400" height="300"', arc(attrs)));
    expect(leaves(file)[0]).toMatchObject({
      type: "ellipse",
      x: 40,
      y: 50,
      width: 120,
      height: 60,
      transform: [1, 0, 0, 1, 0, 0],
      ...want,
    });
    expect(file.warnings).toEqual([]);
  }
  const moved = (transform: string) =>
    leaves(
      parseFile(svg('width="400" height="300"', `<g transform="${transform}">${arc({})}</g>`)),
    )[0];
  expect(moved("translate(10 0) scale(2)")).toMatchObject({
    type: "ellipse",
    x: 90,
    width: 240,
    endAngle: 270,
    transform: [1, 0, 0, 1, 0, 0],
  });
  expect(moved("rotate(30)")).toMatchObject({ type: "ellipse", x: 40, width: 120, endAngle: 270 });
  expect(moved("rotate(30)")?.transform[1]).toBeCloseTo(0.5, 6);
});

it("reads an arc Kalamo cannot hold as the Path its d draws", () => {
  for (const attrs of [{ "sodipodi:rx": -5 }, { "sodipodi:cx": "abc" }] as Record<
    string,
    string | number
  >[]) {
    const file = parseFile(
      svg('width="400" height="300"', arc(attrs).replace('d="M 0 0 Z"', 'd="M 0 0 L 10 0 Z"')),
    );
    expect(leaves(file)[0]).toMatchObject({ type: "path", d: "M 0 0 L 10 0 Z" });
    expect(file.warnings.map((w) => w.code)).toEqual(["ARC_AS_PATH"]);
  }
});

const spiral = (attrs: Record<string, string | number>) =>
  `<path ${Object.entries({
    "sodipodi:type": "spiral",
    "sodipodi:cx": 100,
    "sodipodi:cy": 100,
    "sodipodi:radius": 50,
    "sodipodi:revolution": 3,
    "sodipodi:expansion": 1,
    "sodipodi:argument": 0,
    "sodipodi:t0": 0,
    d: "M 0 0 L 10 0",
    ...attrs,
  })
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")} style="fill:none;stroke:#000000"/>`;

it("opens spirals drawn in Inkscape as spirals that draw Inkscape's outline (ADR-0060)", () => {
  // Inkscape 1.2.2's parameters, and the d it rebuilt from them with object-to-path.
  const drawn = reference.slice(0, 12).filter((r) => r.radius > 0);
  const file = parseFile(
    svg(
      'width="400" height="300" viewBox="0 0 400 300"',
      drawn
        .map(({ d, argument, ...p }) =>
          spiral({
            ...Object.fromEntries(Object.entries(p).map(([k, v]) => [`sodipodi:${k}`, v])),
            "sodipodi:argument": (argument * Math.PI) / 180,
            d,
          }),
        )
        .join(""),
    ),
  );
  expect(file.warnings).toEqual([]);
  const nodes = leaves(file) as ShapeNode[];
  expect(nodes.map((n) => n.type)).toEqual(drawn.map(() => "spiral"));
  nodes.forEach((node, i) => {
    const { d, ...params } = drawn[i] as (typeof drawn)[number];
    expect(node).toMatchObject(params);
    const inkscape = normalizePath(d, "d");
    const ours = shapeSegments(node);
    expect(ours.map((s) => s.cmd)).toEqual(inkscape.map((s) => s.cmd));
    ours.forEach((s, j) => {
      s.args.forEach((v, k) => {
        const want = inkscape[j]?.args[k] ?? Number.NaN;
        expect(Math.abs(v - want)).toBeLessThan(Math.max(0.01, Math.abs(want) * 1e-6));
      });
    });
  });
});

it("reads a bare spiral with Inkscape's defaults, and bakes a move and scale but not a flip", () => {
  const open = (body: string) => leaves(parseFile(svg('width="400" height="300"', body)))[0];
  expect(open('<path sodipodi:type="spiral" d="M 0 0 L 1 0"/>')).toMatchObject({
    type: "spiral",
    cx: 0,
    cy: 0,
    radius: 1,
    revolution: 3,
    expansion: 1,
    argument: 0,
    t0: 0,
  });
  const turned = { "sodipodi:argument": Math.PI / 6, "sodipodi:t0": 0.12345678 };
  expect(open(`<g transform="translate(10 0) scale(2)">${spiral(turned)}</g>`)).toMatchObject({
    type: "spiral",
    cx: 210,
    cy: 200,
    radius: 100,
    argument: 30,
    t0: 0.12345678,
    transform: [1, 0, 0, 1, 0, 0],
  });
  expect(open(spiral({ transform: "matrix(-1,0,0,1,200,0)" }))).toMatchObject({
    type: "spiral",
    cx: 100,
    radius: 50,
    transform: [-1, 0, 0, 1, 200, 0],
  });
});

it.each([
  [{ "sodipodi:revolution": 0.01 }],
  [{ "sodipodi:expansion": 1001 }],
  [{ "sodipodi:t0": 1 }],
  [{ "sodipodi:radius": -1 }],
  [{ "sodipodi:cx": "abc" }],
])("reads a spiral Inkscape would clamp, or cannot read, as the Path its d draws: %j", (attrs) => {
  const file = parseFile(svg('width="400" height="300"', spiral(attrs)));
  expect(leaves(file)[0]).toMatchObject({ type: "path", d: "M 0 0 L 10 0" });
  expect(file.warnings.map((w) => w.code)).toEqual(["SPIRAL_AS_PATH"]);
});

it("keeps a randomized star's parameters as written, its matrix unbaked (ADR-0024)", () => {
  const moved = (attrs: Record<string, string | number>) =>
    `<g transform="translate(10.0004 0) scale(2)">${star({ style: "stroke:#000000;stroke-width:2", ...attrs })}</g>`;
  const file = parseFile(
    svg(
      'width="400" height="300"',
      moved({ "sodipodi:cx": 260.00012345, "inkscape:randomized": 0.1 }) + moved({}),
    ),
  );
  const [randomized, regular] = leaves(file);
  expect(randomized).toMatchObject({
    type: "star",
    cx: 260.00012345,
    outerRadius: 35,
    randomized: 0.1,
    transform: [2, 0, 0, 2, 10.0004, 0],
    appearance: { strokes: [{ width: 2 }] },
  });
  expect(regular).toMatchObject({
    cx: 530,
    outerRadius: 70,
    transform: [1, 0, 0, 1, 0, 0],
    appearance: { strokes: [{ width: 4 }] },
  });
  expect(file.warnings).toEqual([]);
});

describe("a leaf under a writer's rounded uniform scale bakes (#110)", () => {
  const BODY =
    '<rect width="10" height="4" style="stroke:#000;stroke-width:2;stroke-dasharray:1 2" fill="url(#g)"/>' +
    '<circle cx="3" cy="3" r="3" stroke="#000"/>' +
    '<text style="font-size:10">Hi</text>' +
    `<image width="4" height="3" href="${RED_2x2_PNG}"/>` +
    '<path d="M 0 0 L 10 0 L 10 5" stroke="#000"/>' +
    star({});
  const DEFS = `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="10"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#FFF"/></linearGradient></defs>`;
  const open = (groups: string[], body = BODY) =>
    parseFile(
      svg(
        `width="1000" height="1000"`,
        DEFS + groups.reduceRight((inner, t) => `<g transform="${t}">${inner}</g>`, body),
      ),
    );
  const withoutIds = (file: ReturnType<typeof parseFile>) =>
    leaves(file).map(({ id, parentId, ...rest }) => rest);
  const exact = withoutIds(open(["matrix(2,0,0,2,5,5)"]));

  it.each([
    [["matrix(2,0,0,2.0000001,5,5)"]],
    [["matrix(2,1e-8,0,2,5,5)"]],
    [
      [
        "translate(5 5)",
        "matrix(0.7071068,0,0,0.7071067,0,0)",
        "matrix(2.828427,0,0,2.828428,0,0)",
      ],
    ],
  ])("under %j it opens as under an exact ×2", (groups) => {
    const file = open(groups);
    expect(withoutIds(file)).toEqual(exact);
    expect(file.warnings).toEqual([]);
  });

  it("bakes each kind of leaf into document units", () => {
    const [rect, ellipse, text, image, path, polygon] = withoutIds(
      open(["matrix(2,0,0,2.0000001,5,5)"]),
    );
    expect(rect).toMatchObject({
      x: 5,
      width: 20,
      transform: [1, 0, 0, 1, 0, 0],
      appearance: {
        fills: [{ gradient: { start: { x: 5, y: 5 }, end: { x: 25, y: 5 } } }],
        strokes: [{ width: 4, dash: [2, 4] }],
      },
    });
    expect(ellipse).toMatchObject({ width: 12, appearance: { strokes: [{ width: 2 }] } });
    expect(text).toMatchObject({ fontSize: 20 });
    expect(image).toMatchObject({ width: 8, height: 6 });
    expect(path).toMatchObject({ d: "M 5 5 L 25 5 L 25 15" });
    expect(polygon).toMatchObject({ cx: 525, outerRadius: 70 });
    for (const n of [ellipse, text, image, path, polygon]) {
      expect(n?.transform).toEqual([1, 0, 0, 1, 0, 0]);
    }
  });

  it.each(["rotate(0.01)", "skewX(0.01)", "scale(1,1.00001)", "scale(-1,1)", "rotate(180)"])(
    "keeps %s as a matrix",
    (t) => {
      const nodes = withoutIds(open([t]));
      for (const n of nodes) expect(n.transform).not.toEqual([1, 0, 0, 1, 0, 0]);
      expect(nodes[0]).toMatchObject({
        width: 10,
        appearance: { strokes: [{ width: 2 }] },
      });
    },
  );

  it("keeps a randomized star's matrix", () => {
    const [randomized] = withoutIds(
      open(["matrix(2,0,0,2.0000001,0,0)"], star({ "inkscape:randomized": 0.1 })),
    );
    expect(randomized).toMatchObject({ cx: 260, outerRadius: 35, transform: [2, 0, 0, 2, 0, 0] });
  });

  it("gives the same Nodes on a second open of its export", () => {
    const first = open(
      ["matrix(2,0,0,2.0000001,5,5)"],
      '<rect width="10" height="4" stroke="#000"/>',
    );
    const { doc } = createDocument({
      id: "d",
      name: "D",
      artboards: [{ width: 1000, height: 1000 }],
    });
    const opened = { ...doc, nodes: new Map(first.nodes.map((n) => [n.id, n])) };
    expect(withoutIds(parseFile(toSvg(opened)))).toEqual(withoutIds(first));
  });
});

it("opens a star and a polygon drawn in Inkscape as Live Shapes that draw Inkscape's outline", () => {
  // Inkscape 1.2.2's parameters, and the d it rebuilt from them with object-to-path.
  const drawn = [
    star({
      "sodipodi:cx": 150.5,
      "sodipodi:cy": 120.25,
      "sodipodi:r1": 60,
      "sodipodi:r2": 25,
      "sodipodi:arg1": -1.2707963267948965,
      "sodipodi:arg2": -0.49247779607693787,
      "inkscape:rounded": 0.2,
      "inkscape:randomized": 0.12,
      d: "m 171.75288,56.216218 c 8.36249,2.350546 -1.32572,43.01217 4.49726,49.682232 5.03504,5.7675 37.09602,12.13366 36.43889,19.97239 -0.75996,9.06543 -44.46151,4.82775 -48.5396,13.57205 -3.52626,7.56106 18.36068,33.3818 10.75909,35.30782 -8.79117,2.22743 -31.87031,-33.49848 -40.69881,-37.09909 -7.63387,-3.11339 -26.25923,24.85447 -29.16985,17.55565 -3.36609,-8.44101 22.94673,-31.07554 22.94146,-39.73283 -0.005,-7.48583 -34.197419,-27.746034 -29.734883,-34.605011 5.160883,-7.932345 35.670763,16.987865 44.855533,14.370883 7.94194,-2.262865 21.42,-41.056575 28.65091,-39.024094 z",
    }),
    star({
      "sodipodi:sides": 6,
      "sodipodi:cx": 60.75,
      "sodipodi:cy": -30.5,
      "sodipodi:r1": 40,
      "sodipodi:r2": 34.64101615137755,
      "sodipodi:arg1": -1.7707963267948965,
      "sodipodi:arg2": -1.2471975511965976,
      "inkscape:flatsided": "true",
      "inkscape:rounded": 0.3,
      "inkscape:randomized": 0.08,
      d: "m 52.516065,-70.098542 c 11.843478,-3.473183 28.524625,1.500286 35.831111,10.640054 7.306485,9.139768 15.696854,31.995935 12.961004,43.85141 C 98.572326,-3.7516034 82.060741,8.9392118 69.766576,10.922742 57.472411,12.906272 36.082059,4.2433748 28.723487,-5.0163535 21.364915,-14.276082 15.730904,-29.246483 20.862484,-40.167763 c 5.13158,-10.92128 19.810102,-26.457596 31.653581,-29.930779 z",
    }),
  ];
  const file = parseFile(svg('width="400" height="300"', drawn.join("")));
  expect(file.warnings).toEqual([]);
  const nodes = leaves(file) as ShapeNode[];
  expect(nodes.map((n) => n.type)).toEqual(["star", "polygon"]);
  nodes.forEach((node, i) => {
    const inkscape = normalizePath(/ d="([^"]*)"/.exec(drawn[i] ?? "")?.[1] ?? "", "d");
    const ours = shapeSegments(node);
    expect(ours.map((s) => s.cmd)).toEqual(inkscape.map((s) => s.cmd));
    // ADR-0024's model is within 0.14 units of Inkscape.
    ours.forEach((s, j) => {
      s.args.forEach((v, k) => {
        expect(Math.abs(v - (inkscape[j]?.args[k] ?? Number.NaN))).toBeLessThan(0.2);
      });
    });
  });
});

it.each([
  [{ "inkscape:rounded": 11 }],
  // Inkscape jitters a polygon by max(r1, r2); Kalamo's polygon has no r2.
  [{ "inkscape:flatsided": "true", "sodipodi:r2": 50, "inkscape:randomized": 0.1 }],
])("reads a star whose parameters Kalamo cannot hold as its Path: %j", (attrs) => {
  const file = parseFile(svg("", star(attrs)));
  expect(leaves(file)[0]?.type).toBe("path");
  expect(file.warnings.map((w) => w.code)).toEqual(["STAR_AS_PATH"]);
});

it.each(["sodipodi:r2", "sodipodi:arg1", "sodipodi:arg2"])(
  "reads a star whose %s is not a number as its Path",
  (name) => {
    const file = parseFile(svg("", star({ [name]: "x" })));
    expect(leaves(file)[0]?.type).toBe("path");
    expect(file.warnings.map((w) => w.code)).toEqual(["STAR_AS_PATH"]);
  },
);

it("reads <text> as one Point Type, its Inkscape lines joined by returns, keeping the font name", () => {
  const file = parseFile(
    svg(
      'width="300" height="300"',
      '<text x="20" y="195" font-family="Source Sans 3" font-size="14" style="font-kerning:none" xml:space="preserve">Round &amp;  trip</text>' +
        `<text id="z-01M38T29SBZ873XP2NBD2K6CYR" style="font-size:4.2mm;font-family:'DejaVu Sans', sans-serif;fill:#ff0000">` +
        '<tspan sodipodi:role="line" x="10" y="20">  a\n</tspan>' +
        '<tspan sodipodi:role="line" x="10" y="30">b<tspan style="font-weight:bold">c</tspan></tspan>' +
        '<tspan sodipodi:role="line" x="10" y="40"/></text>' +
        '<text x="100" y="10" text-anchor="middle" font-size="10">Hi</text>' +
        '<text x="0" y="0">   </text>',
    ),
  );
  const [plain, abc, centred, ...rest] = leaves(file);
  expect(rest).toEqual([]);
  expect(plain).toMatchObject({
    type: "text",
    kind: "point",
    x: 20,
    y: 195,
    content: "Round &  trip",
    fontFamily: "Source Sans 3",
    fontSize: 14,
    appearance: { fills: [{ color: "#000000" }], strokes: [] },
  });
  expect(plain).not.toHaveProperty("leading");
  expect(abc).toMatchObject({
    id: "01M38T29SBZ873XP2NBD2K6CYR",
    x: 10,
    y: 20,
    content: "a\nbc\n",
    fontFamily: "DejaVu Sans",
    fontSize: 11.906,
    appearance: { fills: [{ color: "#FF0000" }] },
    ranges: [{ start: 3, end: 4, fontStyle: "Bold" }],
  });
  // Half of "Hi"'s advances at 10 pt: (652 + 246) × 10 / 1000 / 2.
  expect(centred).toMatchObject({ x: 95.51, content: "Hi" });
  // The bold tspan's face is missing too (ADR-0068).
  expect(file.warnings).toEqual([
    expect.objectContaining({ code: "FONT_MISSING", nodeId: abc?.id }),
    expect.objectContaining({ code: "FONT_MISSING", message: expect.stringMatching(/Sans Bold/) }),
  ]);
});

it("reads font-weight and font-style as the style name, inherited as CSS inherits them (ADR-0028)", () => {
  const texts = [
    "",
    'font-weight="bold"',
    'style="font-weight:600;font-style:oblique"',
    'font-style="italic"',
    'font-weight="650"',
    'font-weight="bolder"',
    'font-weight="lighter"',
    'style="font-weight:BOLD;font-style:Italic"',
  ];
  const file = parseFile(
    svg(
      'width="300" height="300"',
      texts.map((a, i) => `<text x="0" y="${10 + i * 10}" ${a}>a</text>`).join("") +
        '<g font-weight="900"><text x="0" y="90">a</text></g>' +
        '<text x="100" y="100" text-anchor="middle" font-weight="bold" font-size="10">Hi</text>',
    ),
  );
  const read = leaves(file);
  expect(read.map((n) => "fontStyle" in n && n.fontStyle)).toEqual([
    "Regular",
    "Bold",
    "Semibold Italic",
    "Italic",
    "Bold",
    "Bold",
    "Thin",
    "Bold Italic",
    "Black",
    "Bold",
  ]);
  // Half of "Hi"'s Bold advances at 10 pt: (674 + 276) × 10 / 1000 / 2.
  expect(read.at(-1)).toMatchObject({ x: 95.25 });
  // In Noto Sans SC, by its own advances: (728 + 275) × 10 / 1000 / 2 (ADR-0063).
  const noto = parseFile(
    svg(
      'width="300" height="300"',
      '<text x="100" y="100" text-anchor="middle" font-family="Noto Sans SC" font-size="10">Hi</text>',
    ),
  );
  expect(leaves(noto)[0]).toMatchObject({ x: 94.985, fontFamily: "Noto Sans SC" });
  // Semibold Italic and Thin are not bundled.
  expect(file.warnings.map((w) => w.message)).toEqual([
    "Source Sans 3 Semibold Italic is not bundled, so it renders in Source Sans 3 Bold Italic; the name is kept.",
    "Source Sans 3 Thin is not bundled, so it renders in Source Sans 3; the name is kept.",
  ]);
});

describe("tracking and Character Ranges (ADR-0029)", () => {
  const read = (body: string, attrs = "") =>
    parseFile(svg(`width="300" height="300" ${attrs}`, body));
  const text = (body: string) => leaves(read(body))[0] as unknown as Record<string, unknown>;

  it("reads letter-spacing as tracking, and nested tspans as ranges", () => {
    expect(
      text(
        '<text x="10" y="50" font-size="20" letter-spacing="2"><tspan sodipodi:role="line" x="10" y="50">H<tspan fill="#ff0000" fill-opacity="0.5">e</tspan><tspan baseline-shift="3"><tspan baseline-shift="1" rotate="10 20">llo</tspan></tspan></tspan></text>',
      ),
    ).toMatchObject({
      content: "Hello",
      tracking: 100,
      ranges: [
        { start: 1, end: 2, fill: "#FF000080" },
        { start: 2, end: 3, baselineShift: 4, rotation: 10 },
        { start: 3, end: 5, baselineShift: 4, rotation: 20 },
      ],
    });
  });

  it("takes each character's rotation from the nearest list, its last angle past its end", () => {
    expect(text('<text rotate="5 0 7">abcd</text>').ranges).toEqual([
      { start: 0, end: 1, rotation: 5 },
      { start: 2, end: 4, rotation: 7 },
    ]);
    expect(text('<text rotate="5">ab<tspan rotate="9">c</tspan>d</text>').ranges).toEqual([
      { start: 0, end: 2, rotation: 5 },
      { start: 2, end: 3, rotation: 9 },
      { start: 3, end: 4, rotation: 5 },
    ]);
  });

  it("indexes a rotate list by the characters left after whitespace collapses", () => {
    expect(
      text('<text rotate="10 20 30">\n  <tspan sodipodi:role="line">abc</tspan>\n</text>').ranges,
    ).toEqual([
      { start: 0, end: 1, rotation: 10 },
      { start: 1, end: 2, rotation: 20 },
      { start: 2, end: 3, rotation: 30 },
    ]);
    expect(text('<text rotate="10 20 30 40">a  b</text>').ranges).toEqual([
      { start: 0, end: 1, rotation: 10 },
      { start: 1, end: 2, rotation: 20 },
      { start: 2, end: 3, rotation: 30 },
    ]);
  });

  it("indexes a rotate list by every character where whitespace is preserved", () => {
    expect(text('<text xml:space="preserve" rotate="10 20 30 40">a  b</text>').ranges).toEqual([
      { start: 0, end: 1, rotation: 10 },
      { start: 1, end: 2, rotation: 20 },
      { start: 2, end: 3, rotation: 30 },
      { start: 3, end: 4, rotation: 40 },
    ]);
  });

  it("reads a tspan's letter-spacing as its characters' tracking, in their em (ADR-0068)", () => {
    const file = read(
      '<text font-size="20" letter-spacing="2">a<tspan letter-spacing="5">b</tspan><tspan letter-spacing="0.1em">c</tspan><tspan letter-spacing="normal">d</tspan></text>',
    );
    expect(file.warnings).toEqual([]);
    expect(leaves(file)[0]).toMatchObject({
      tracking: 100,
      ranges: [
        { start: 1, end: 2, tracking: 250 },
        { start: 3, end: 4, tracking: 0 },
      ],
    });
  });

  it("reads a tspan's weight and italic as its characters' style (ADR-0068)", () => {
    const file = read(
      '<text font-weight="bold">a<tspan font-weight="normal">b</tspan><tspan font-style="italic">c</tspan><tspan font-weight="300" font-style="oblique">d</tspan><tspan font-weight="700">e</tspan></text>',
    );
    expect(file.warnings.map((w) => w.message)).toEqual([
      "Source Sans 3 Light Italic is not bundled, so it renders in Source Sans 3 Italic; the name is kept.",
    ]);
    expect(leaves(file)[0]).toMatchObject({
      fontStyle: "Bold",
      ranges: [
        { start: 1, end: 2, fontStyle: "Regular" },
        { start: 2, end: 3, fontStyle: "Bold Italic" },
        { start: 3, end: 4, fontStyle: "Light Italic" },
      ],
    });
  });

  it("scales baseline shift with a baked scale, and tracking not at all", () => {
    expect(
      text(
        '<g transform="scale(2)"><text font-size="20" letter-spacing="2">a<tspan baseline-shift="3">b</tspan><tspan letter-spacing="4">c</tspan></text></g>',
      ),
    ).toMatchObject({
      fontSize: 40,
      tracking: 100,
      ranges: [
        { start: 1, end: 2, baselineShift: 6 },
        { start: 2, end: 3, tracking: 200 },
      ],
    });
  });

  it.each([
    ["0.1em", 100],
    ["1rem", undefined],
    ["normal", undefined],
  ])("reads letter-spacing %s as tracking %s", (spacing, tracking) => {
    expect(text(`<text letter-spacing="${spacing}">ab</text>`).tracking).toBe(tracking);
  });

  it("collapses whitespace per character, a run keeping its first character's attributes", () => {
    expect(text('<text>a  <tspan fill="#f00">b</tspan></text>')).toMatchObject({
      content: "a b",
      ranges: [{ start: 2, end: 3, fill: "#FF0000" }],
    });
  });

  it("measures text-anchor with the tracking", () => {
    expect(
      text('<text x="100" text-anchor="middle" font-size="10" letter-spacing="1">Hi</text>'),
    ).toMatchObject({ x: 95.01 });
    // And with a range's: H tracks 3 of 10 pt.
    expect(
      text(
        '<text x="100" text-anchor="middle" font-size="10" letter-spacing="1"><tspan letter-spacing="3">H</tspan>i</text>',
      ),
    ).toMatchObject({ x: 94.01 });
  });

  it.each([
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><text>a<tspan fill="url(#g)">b</tspan></text>',
    '<text>a<tspan baseline-shift="super">b</tspan></text>',
    '<text>a<tspan baseline-shift="30%">b</tspan></text>',
    '<text fill="none" stroke="#000">a<tspan fill="#f00">b</tspan></text>',
    '<text>a<tspan stroke="#f00">b</tspan></text>',
    '<text stroke="#000" stroke-width="0">a<tspan stroke="#f00">b</tspan></text>',
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><text stroke="#000">a<tspan stroke="url(#g)">b</tspan></text>',
    '<text stroke="#000">a<tspan stroke="none">b</tspan></text>',
    '<text stroke="#000">a<tspan stroke-width="3">b</tspan></text>',
    '<text stroke="#000">a<tspan stroke-dasharray="1 1">b</tspan></text>',
  ])("warns for what a range cannot hold, and makes none: %s", (body) => {
    const file = read(body);
    expect(file.warnings).toEqual([expect.objectContaining({ code: "UNSUPPORTED_ATTRIBUTE" })]);
    expect(leaves(file).find((n) => n.type === "text")).not.toHaveProperty("ranges");
  });

  it("reads a tspan's stroke on a text with a Stroke as a range stroke (ADR-0068)", () => {
    const file = read(
      '<text stroke="#000" stroke-opacity="0.5">a<tspan stroke="#f00">b</tspan><tspan stroke-opacity="1">c</tspan><tspan stroke="#000000">d</tspan></text>',
    );
    expect(file.warnings).toEqual([]);
    expect(leaves(file)[0]).toMatchObject({
      ranges: [
        { start: 1, end: 2, stroke: "#FF000080" },
        { start: 2, end: 3, stroke: "#000000" },
      ],
    });
  });

  it("reads a none fill under a none fill as no range and no warning", () => {
    const file = read('<text fill="none" stroke="#000">a<tspan fill-opacity="1">b</tspan></text>');
    expect(file.warnings).toEqual([]);
    expect(leaves(file).find((n) => n.type === "text")).not.toHaveProperty("ranges");
  });

  it("reads back what toSvg writes", () => {
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "D",
      name: "Doc",
      artboards: [{ width: 200, height: 200 }],
    });
    const [node] = createNodes(doc, [
      {
        type: "text",
        parentId,
        x: 0,
        y: 20,
        content: "Hello",
        fontSize: 20,
        tracking: 100,
        appearance: {
          fills: [{ color: "#000000" }],
          strokes: [{ color: "#0000FF", width: 1 }],
        },
        ranges: [
          { start: 0, end: 1, fill: "#FF000080" },
          { start: 1, end: 2, stroke: "#00FF00", tracking: -50 },
          { start: 2, end: 4, baselineShift: 3, rotation: -15, stroke: "#FF000080" },
          { start: 4, end: 5, tracking: 0, fontStyle: "Black Italic" },
        ],
      },
    ]).nodes;
    const file = parseFile(toSvg(doc));
    expect(file.warnings).toEqual([]);
    expect(leaves(file)[0]).toMatchObject({
      tracking: 100,
      ranges: node && "ranges" in node && node.ranges,
    });
  });
});

// Saved by Inkscape 1.2.2 (ADR-0022): line tspans, and flowed text with its positioned fallback
// lines, overflow included; the frames Inkscape keeps in <defs>.
const INKSCAPE_TEXT =
  '<defs><rect id="box" x="150" y="20" width="100" height="80" fill="none" /><rect id="b1" x="10" y="10" width="100" height="40" /><rect id="b2" x="10" y="60" width="50" height="100" /><rect id="b3" x="150" y="10" width="100" height="100" /></defs>' +
  '<text id="t1" x="20" y="40" font-family="Source Sans 3" font-size="12" style="font-kerning:none;line-height:1.2" xml:space="preserve"><tspan sodipodi:role="line" x="20" y="40" id="tspan2">First line</tspan><tspan sodipodi:role="line" x="20" y="54.4" id="tspan4" /><tspan sodipodi:role="line" x="20" y="68.8" id="tspan6">Third</tspan></text>' +
  '<text id="t2" font-family="Source Sans 3" font-size="12" style="shape-inside:url(#box);white-space:pre;line-height:1.2" xml:space="preserve"><tspan x="150" y="30.249774" id="tspan26">The quick brown </tspan><tspan x="150" y="44.649776" id="tspan28">fox jumps over the </tspan><tspan x="150" y="59.049777" id="tspan30">lazy dog again and </tspan><tspan x="150" y="73.449779" id="tspan32">again.\n</tspan><tspan x="150" y="87.84978" id="tspan34">New para</tspan></text>' +
  '<text id="over" font-family="Source Sans 3" font-size="12" style="shape-inside:url(#b1);white-space:pre;line-height:1.2" xml:space="preserve"><tspan x="10" y="20.249774" id="tspan35">one\n</tspan><tspan x="10" y="34.649776" id="tspan37">two\n</tspan><tspan x="10" y="60.249774" id="tspan41"><tspan dx="0 4.0559921 6.5280075 4.0439987 5.9520035 5.9520035" id="tspan39">three\n</tspan></tspan><tspan x="10" y="74.649775" id="tspan45"><tspan dx="0 3.3839951 6.5039978 6.5280075" id="tspan43">four</tspan></tspan></text>' +
  '<text id="long" font-family="Source Sans 3" font-size="12" style="shape-inside:url(#b2);white-space:pre;line-height:1.2" xml:space="preserve"><tspan x="10" y="170.24977" id="tspan49"><tspan dx="0 6.4080048 6.5280075 6.6600037 5.9520035 4.0439987 5.3519897 6.0479965 3.0599899 2.9520035 3.5039978 3.8759995 6.0479965 6.0479965 2.9520035 3.0599899 2.9520035 4.788002 4.0559921 2.9520035 5.4719925 2.4000092 8.5800018 6.5039978 4.0439987 6.6600037 2.4000092 2.4000092 4.0559921 8.5800018 6.5039978 2.4000092 2.4000092 2.4000092 5.0279999 6.4920044 6.0480042 5.2200012 5.9519958" id="tspan47">Supercalifragilistic word  two   spaces</tspan></tspan></text>' +
  '<text id="empty" font-family="Source Sans 3" font-size="12" style="shape-inside:url(#b3);white-space:pre;line-height:15px" xml:space="preserve"><tspan x="150" y="20.549774" id="tspan51">a\n</tspan><tspan x="150" y="35.549774" id="tspan53">\n</tspan><tspan x="150" y="50.549774" id="tspan55">b\n</tspan></text>' +
  '<text id="pt" x="20" y="180" font-family="Source Sans 3" font-size="12" style="line-height:15px" xml:space="preserve"><tspan sodipodi:role="line" x="20" y="180" id="tspan12">First</tspan><tspan sodipodi:role="line" x="20" y="182" id="tspan14">Second</tspan></text>';

it("reads Inkscape's multi-line and flowed text as one Text Node each", () => {
  const file = parseFile(svg('width="300" height="200" viewBox="0 0 300 200"', INKSCAPE_TEXT));
  const byName = Object.fromEntries(
    leaves(file).map((n) => [n.type === "text" ? n.content.slice(0, 7) : n.type, n]),
  );
  expect(leaves(file)).toHaveLength(6);
  expect(file.warnings).toEqual([]);
  expect(byName["First l"]).toMatchObject({
    kind: "point",
    x: 20,
    y: 40,
    content: "First line\n\nThird",
  });
  expect(byName["First l"]).not.toHaveProperty("leading");
  expect(byName["The qui"]).toMatchObject({
    kind: "area",
    x: 150,
    y: 20,
    width: 100,
    height: 80,
    content: "The quick brown fox jumps over the lazy dog again and again.\nNew para",
  });
  expect(byName["one\ntwo"]).toMatchObject({
    x: 10,
    y: 10,
    width: 100,
    height: 40,
    content: "one\ntwo\nthree\nfour",
  });
  expect(byName.Superca).toMatchObject({ content: "Supercalifragilistic word  two   spaces" });
  expect(byName["a\n\nb\n"]).toMatchObject({ kind: "area", leading: 15, content: "a\n\nb\n" });
  expect(byName["First\nS"]).toMatchObject({ kind: "point", x: 20, y: 180, leading: 15 });
});

it.each([
  ["1.25", 15],
  ["150%", 18],
  ["15px", 15],
  ["1.2", undefined],
  ["normal", undefined],
])("reads line-height %s as leading %s at 12 pt", (lineHeight, leading) => {
  const file = parseFile(
    svg(
      "",
      `<text x="0" y="10" font-size="12" style="line-height:${lineHeight}"><tspan sodipodi:role="line">a</tspan><tspan sodipodi:role="line">b</tspan></text>`,
    ),
  );
  expect((leaves(file)[0] as { leading?: number }).leading).toBe(leading);
});

it("scales Area Type's frame and leading with a baked scale", () => {
  const file = parseFile(
    svg(
      "",
      '<defs><rect id="f" x="10" y="10" width="100" height="40"/></defs>' +
        '<text transform="matrix(2 0 0 2 5 0)" font-size="12" style="shape-inside:url(#f);white-space:pre;line-height:15px">a</text>',
    ),
  );
  expect(leaves(file)[0]).toMatchObject({
    x: 25,
    y: 20,
    width: 200,
    height: 80,
    fontSize: 24,
    leading: 30,
  });
});

it("warns when Area Type cannot flow as written, and keeps its text", () => {
  const file = parseFile(
    svg(
      "",
      '<defs><circle id="c" cx="50" cy="50" r="40"/></defs>' +
        '<text font-size="12" style="shape-inside:url(#c);white-space:pre">in a circle</text>' +
        '<text x="5" y="5" font-size="12" style="shape-inside:url(#nope);white-space:pre">a\nb</text>' +
        '<text x="50" y="50" text-anchor="middle"><tspan sodipodi:role="line">a</tspan><tspan sodipodi:role="line">b</tspan></text>' +
        '<defs><rect id="r" width="50" height="50"/></defs>' +
        '<text style="shape-inside:url(#r);text-anchor:middle"><title>Note</title>centred</text>',
    ),
  );
  const [circle, missing, centred, area] = leaves(file);
  expect(area).toMatchObject({ kind: "area", x: 0, y: 0, content: "centred" });
  // Warnings come once per kind, so the centred Area Type is checked on its own.
  const alone = parseFile(
    svg(
      "",
      '<defs><rect id="r" width="50" height="50"/></defs><text style="shape-inside:url(#r);text-anchor:end">a</text>',
    ),
  );
  expect(alone.warnings).toEqual([expect.objectContaining({ code: "UNSUPPORTED_ATTRIBUTE" })]);
  expect(alone.warnings[0]?.message).toMatch(/^text-anchor/);
  expect(circle).toMatchObject({
    kind: "area",
    x: 10,
    y: 10,
    width: 80,
    height: 80,
    content: "in a circle",
  });
  expect(missing).toMatchObject({ kind: "point", x: 5, y: 5, content: "a\nb" });
  expect(centred).toMatchObject({ kind: "point", content: "a\nb" });
  expect(file.warnings.map((w) => [w.code, w.message.split(" ")[0]])).toEqual([
    ["UNSUPPORTED_ATTRIBUTE", "shape-inside"],
    ["UNSUPPORTED_ATTRIBUTE", "text-anchor"],
  ]);
});

it("keeps fill-rule on what becomes a Path, and drops it without a warning elsewhere", () => {
  const d = "M 0 0 L 9 0 L 9 9 Z M 3 3 L 6 3 L 6 6 Z";
  const file = parseFile(
    svg(
      'width="10" height="10"',
      `<path d="${d}" fill-rule="evenodd"/><path d="${d}" style="fill-rule:evenodd"/>` +
        '<g fill-rule="evenodd"><polygon points="0 0 9 0 9 9"/></g>' +
        `<g kalamo:stack="true" style="fill-rule:evenodd"><path d="${d}" fill="#FF0000"/><path d="${d}" fill="#0000FF"/></g>` +
        `<path d="${d}"/><rect fill-rule="evenodd" width="1" height="1"/>` +
        // Kalamo's own export of a two-Fill evenodd Path: the rule on each paint.
        `<g kalamo:stack="true"><path d="${d}" fill-rule="evenodd" fill="#FF0000"/><path d="${d}" fill-rule="evenodd" fill="#0000FF"/></g>`,
    ),
  );
  expect(leaves(file).map((n) => [n.type, "fillRule" in n ? n.fillRule : undefined])).toEqual([
    ["path", "evenodd"],
    ["path", "evenodd"],
    ["path", "evenodd"],
    ["path", "evenodd"],
    ["path", "nonzero"],
    ["rect", undefined],
    ["path", "evenodd"],
  ]);
  expect(leaves(file)[3]).toMatchObject({ appearance: { fills: [{}, {}] } });
  expect(file.warnings).toEqual([]);
});

it("opens a file with content Kalamo cannot hold, with one warning per kind", () => {
  const id = "z-01M38T29SBZ873XP2NBD2K6CYR";
  const file = parseFile(
    svg(
      'width="100" height="100" xmlns:xlink="http://www.w3.org/1999/xlink"',
      '<defs><symbol id="s"><rect width="1" height="1"/></symbol><filter id="f"/><clipPath id="c"><rect width="5" height="5"/></clipPath>' +
        '<pattern id="p" width="2" height="2"/></defs>' +
        '<use xlink:href="#s"/><use href="#s"/><image href="data:image/png;base64,AAAA" width="1" height="1"/>' +
        "<flowRoot><flowPara>x</flowPara></flowRoot><foreignObject><div/></foreignObject>" +
        "<script>alert(1)</script><svg/><foo/>" +
        '<rect clip-path="url(#c)" mask="url(#m)" style="filter:url(#f)" width="2" height="2"/>' +
        '<path inkscape:path-effect="#e" inkscape:original-d="M 0 0 L 9 9" d="M 0 0 L 1 1"/>' +
        '<g sodipodi:type="inkscape:box3d"><path sodipodi:type="inkscape:box3dside" d="M 0 0 L 2 0 L 2 2 Z"/></g>' +
        '<rect fill="url(#p)" width="1" height="1"/>' +
        `<rect id="${id}" width="1" height="1"/><rect id="${id}" width="1" height="1"/>` +
        '<path d="M 0 0 L 1 1 M 0 1 L 1 0 Z" fill-rule="evenodd" marker-end="url(#m)"/>' +
        '<path d="M 0 0 X"/>',
    ),
  );
  // The clipped rect and its Clipping Path, in a Group of their own.
  expect(leaves(file).map((n) => n.type)).toEqual([
    "rect",
    "rect",
    "path",
    "path",
    "rect",
    "rect",
    "rect",
    "path",
  ]);
  expect(leaves(file)[1]).toMatchObject({ clipping: true });
  expect(leaves(file)[2]).toMatchObject({ d: "M 0 0 L 1 1" });
  const codes = file.warnings.map((w) => w.code);
  expect(codes.filter((c) => c === "UNSUPPORTED_ELEMENT")).toHaveLength(6);
  expect(new Set(codes)).toEqual(
    new Set([
      "UNSUPPORTED_ELEMENT",
      "UNSUPPORTED_ATTRIBUTE",
      "PATH_EFFECT_FLATTENED",
      "BOX3D_AS_PATHS",
      "UNSUPPORTED_PAINT",
      "DUPLICATE_ID",
      "INVALID_PATH",
      "INVALID_IMAGE",
    ]),
  );
  // mask, filter and marker-end; the clip-path is held.
  expect(codes.filter((c) => c === "UNSUPPORTED_ATTRIBUTE")).toHaveLength(3);
  for (const w of file.warnings) expect(w.message).not.toBe("");
});

it("drops an element its Node cannot hold with one warning per kind, keeping the rest", () => {
  const bad = [
    '<text font-size="0">zero</text>',
    '<text font-size="-3">negative</text>',
    '<rect width="-5" height="5"/>',
    '<circle r="-5"/>',
    '<rect x="1e400" width="5" height="5"/>',
  ];
  const good =
    '<rect id="z-01ARZ3NDEKTSV4RRFFQ69G5FAV" x="1" y="2" width="3" height="4" fill="#FF0000"/>';
  const at = (body: string) => parseFile(svg('viewBox="0 0 10 10" width="10"', body));
  const own = (f: ReturnType<typeof at>) => leaves(f).map(({ parentId, index, ...n }) => n);
  const file = at(`<g>${bad.join("")}</g>${good}`);
  expect(own(file)).toEqual(own(at(good)));
  expect(file.warnings.map((w) => [w.code, w.message])).toEqual(
    // A circle is an ellipse, so r="-5" is a width like the rect's.
    ["fontSize", "width", "x"].map((key) => [
      "INVALID_ELEMENT",
      expect.stringMatching(new RegExp(`^An element was dropped: element\\.${key}: `)),
    ]),
  );
});

it("drops an Image, Clipping Path or container paint its Node cannot hold, keeping the rest", () => {
  const file = parseFile(
    svg(
      "",
      `<image x="1e400" width="2" height="2" href="${RED_2x2_PNG}"/>` +
        '<image x="1e400" width="2" height="2" href="a.png"/>' +
        '<clipPath id="c"><rect width="-5" height="5"/></clipPath>' +
        '<rect clip-path="url(#c)" width="3" height="3"/>' +
        '<g><g kalamo:paint="true" fill="none" stroke="#000000" stroke-width="1e400"><rect width="1" height="1"/></g>' +
        '<g kalamo:paint="true" fill="#FF0000"><rect width="1" height="1"/></g>' +
        '<rect width="2" height="2"/></g>',
    ),
  );
  // The clipped rect comes in unclipped, and the Group keeps the paint it can hold.
  expect(leaves(file)).toMatchObject([
    { type: "rect", width: 3 },
    { type: "rect", width: 2 },
  ]);
  expect(file.nodes.some((n) => n.type === "rect" && n.clipping)).toBe(false);
  expect(file.nodes.find((n) => n.type === "group" && n.appearance)).toMatchObject({
    appearance: { fills: [{ color: "#FF0000" }], strokes: [] },
  });
  expect(file.images.size).toBe(0);
  expect(file.warnings.map((w) => w.message)).toEqual(
    ["x", "width", "appearance.strokes[0].width"].map((key) =>
      expect.stringContaining(`dropped: element.${key}: `),
    ),
  );
});

it("opens a control character in text as a space, not a failed Open", () => {
  const file = parseFile(svg("", "<text>a&#x0B;b</text><text>c&#x7F;d</text>"));
  expect(leaves(file).map((n) => n.type === "text" && n.content)).toEqual(["a b", "c d"]);
  expect(file.warnings).toEqual([]);
});

it("ignores a stack paint's unreadable transform, and drops one scaled to nothing, as walk does", () => {
  const stack = (transform: string) =>
    parseFile(
      svg(
        "",
        `<g kalamo:stack="true"><rect width="5" height="5" fill="#FF0000" transform="${transform}"/><rect width="5" height="5" fill="none" stroke="#0000FF"/></g>`,
      ),
    );
  const unreadable = stack("scale(1e400)");
  expect(leaves(unreadable)).toMatchObject([
    { type: "rect", width: 5, transform: [1, 0, 0, 1, 0, 0] },
  ]);
  expect(unreadable.warnings).toMatchObject([{ code: "INVALID_TRANSFORM" }]);
  const flat = stack("scale(0)");
  expect(leaves(flat)).toMatchObject([{ appearance: { fills: [], strokes: [{}] } }]);
  expect(flat.warnings).toMatchObject([{ code: "INVALID_TRANSFORM" }]);
});

it("refuses Groups nested deeper than MAX_DEPTH with LIMIT_EXCEEDED", () => {
  const deep = (n: number) =>
    svg("", `${"<g>".repeat(n)}<rect width="1" height="1"/>${"</g>".repeat(n)}`);
  expect(leaves(parseFile(deep(MAX_DEPTH - 1)))).toHaveLength(1);
  expect(errorOf(() => parseFile(deep(5000)))).toMatchObject({
    code: "LIMIT_EXCEEDED",
    path: "content",
  });
});

it("warns about clipping, masks and filters on a Group too", () => {
  const file = parseFile(
    svg(
      "",
      '<g clip-path="url(#c)" mask="url(#m)" filter="url(#f)"><rect width="1" height="1"/></g>',
    ),
  );
  expect(file.warnings.map((w) => w.code)).toEqual([
    "UNSUPPORTED_ATTRIBUTE",
    "UNSUPPORTED_ATTRIBUTE",
    "UNSUPPORTED_ATTRIBUTE",
  ]);
});

it("ignores an unreadable transform and drops an element scaled to nothing", () => {
  const file = parseFile(
    svg(
      "",
      '<rect transform="matrix(1 0 0)" x="2" width="1" height="1"/><rect transform="scale(0)" width="1" height="1"/>',
    ),
  );
  expect(leaves(file)).toMatchObject([{ x: 2, transform: [1, 0, 0, 1, 0, 0] }]);
  expect(file.warnings.map((w) => w.code)).toEqual(["INVALID_TRANSFORM", "INVALID_TRANSFORM"]);
});

describe("Clipping Masks (ADR-0021)", () => {
  const G = "z-01J00000000000000000000G01";
  const C = "z-01J00000000000000000000C01";
  const byId = (file: ReturnType<typeof parseFile>, xml: string) =>
    file.nodes.find((n) => `z-${n.id}` === xml);
  const children = (file: ReturnType<typeof parseFile>, id: string | undefined) =>
    file.nodes.filter((n) => n.parentId === id).sort((a, b) => (a.index < b.index ? -1 : 1));

  it("reads Inkscape's clipped Group, the clip in <defs> under a new id, as a Clipping Mask", () => {
    const file = parseFile(
      svg(
        'width="200" height="200" viewBox="0 0 200 200"',
        '<defs><clipPath clipPathUnits="userSpaceOnUse" id="clipPath13"><circle id="circle15" cx="80" cy="80" r="50" fill="#00ff00" opacity="0.5"/></clipPath></defs>' +
          `<g id="${G}" clip-path="url(#clipPath13)" transform="translate(10 0)"><rect width="100" height="100" fill="#FF0000"/></g>`,
      ),
    );
    expect(file.warnings).toEqual([]);
    const group = byId(file, G);
    const [rect, clip] = children(file, group?.id);
    expect(rect).toMatchObject({ type: "rect", x: 10 });
    // On top, in the Group's user space. Set Clip left the circle's old style there, which SVG
    // never draws, so it is unpainted (ADR-0051).
    expect(clip).toMatchObject({
      type: "ellipse",
      x: 40,
      y: 30,
      width: 100,
      clipping: true,
      opacity: 1,
      appearance: { fills: [], strokes: [] },
    });
  });

  it("reads Kalamo's inline <clipPath> where it sits, with its id and clip-rule", () => {
    const file = parseFile(
      svg(
        "",
        `<g id="${G}" clip-path="url(#clip-${G})"><rect width="9" height="9"/>` +
          `<clipPath id="clip-${G}" clipPathUnits="userSpaceOnUse"><path id="${C}" d="M 0 0 L 9 0 L 9 9 Z" fill="none" clip-rule="evenodd"/></clipPath>` +
          '<rect x="5" width="9" height="9"/></g>',
      ),
    );
    const group = byId(file, G);
    expect(children(file, group?.id).map((n) => n.type)).toEqual(["rect", "path", "rect"]);
    expect(byId(file, C)).toMatchObject({
      clipping: true,
      fillRule: "evenodd",
      parentId: group?.id,
    });
  });

  it("wraps a clipped leaf in a new Group, the clip in the leaf's user space", () => {
    const file = parseFile(
      svg(
        "",
        '<defs><clipPath id="c"><rect x="1" y="1" width="2" height="2"/></clipPath></defs>' +
          '<rect id="z-01J00000000000000000000R01" transform="translate(10 20)" clip-path="url(#c)" width="5" height="5"/>',
      ),
    );
    const rect = byId(file, "z-01J00000000000000000000R01");
    const group = file.nodes.find((n) => n.id === rect?.parentId);
    expect(group).toMatchObject({ type: "group", name: "" });
    expect(children(file, group?.id)).toMatchObject([
      { type: "rect", x: 10, y: 20 },
      { type: "rect", x: 11, y: 21, width: 2, clipping: true },
    ]);
  });

  it("imports unclipped, warning once, a clip Kalamo cannot hold", () => {
    const clip = (inner: string, attrs = "") =>
      parseFile(
        svg(
          "",
          `<defs><clipPath id="c" ${attrs}>${inner}</clipPath></defs><g clip-path="url(#c)"><rect width="5" height="5"/></g>`,
        ),
      );
    for (const file of [
      clip('<text x="0" y="5">Hi</text><text x="0" y="9">Ho</text>'),
      clip('<text x="0" y="5">Hi</text><rect width="1" height="1"/>'),
      clip('<text><textPath href="#p">Hi</textPath></text>'),
      clip('<text x="0" y="5">   </text>'),
      clip('<rect width="1" height="1"/><rect width="2" height="2"/>'),
      clip('<g><rect width="1" height="1"/></g>'),
      clip('<rect width="1" height="1"/>', 'clipPathUnits="objectBoundingBox"'),
      clip('<rect width="1" height="1"/>', 'clip-path="url(#d)"'),
      parseFile(svg("", '<g clip-path="url(#nope)"><rect width="5" height="5"/></g>')),
      // A Layer's, for the same reasons as a Group's (ADR-0053).
      parseFile(
        svg(
          "",
          '<defs><clipPath id="c"><rect width="1" height="1"/><rect width="2" height="2"/></clipPath></defs><g inkscape:groupmode="layer" clip-path="url(#c)"><rect width="5" height="5"/></g>',
        ),
      ),
    ]) {
      expect(file.warnings).toMatchObject([{ code: "UNSUPPORTED_ATTRIBUTE" }]);
      expect(file.nodes.some((n) => "clipping" in n)).toBe(false);
    }
  });

  it("reads a layer's inline <clipPath> as the Layer's Clipping Path, where it sits (ADR-0053)", () => {
    const file = parseFile(
      svg(
        "",
        `<g id="${G}" inkscape:groupmode="layer" clip-path="url(#k)"><rect width="9" height="9"/>` +
          `<clipPath id="k" clipPathUnits="userSpaceOnUse"><path id="${C}" d="M 0 0 L 9 0 L 9 9 Z"/></clipPath>` +
          '<rect x="5" width="9" height="9"/></g>',
      ),
    );
    expect(file.warnings).toEqual([]);
    const layer = byId(file, G);
    expect(layer).toMatchObject({ type: "layer", parentId: null });
    expect(children(file, layer?.id).map((n) => n.type)).toEqual(["rect", "path", "rect"]);
    expect(byId(file, C)).toMatchObject({ clipping: true, parentId: layer?.id });
  });

  it("reads Inkscape's Set Clip on a translated layer as a Clipping Path on top, unpainted (ADR-0053)", () => {
    // As select-by-id:L1,c1;object-set-clip writes it: the clip in <defs> under a new id, in the
    // layer's user space, the object's old style left on it.
    const file = parseFile(
      svg(
        "",
        '<defs><clipPath clipPathUnits="userSpaceOnUse" id="clipPath7"><rect id="c1" x="0" y="0" width="4" height="4" style="fill:#0000ff;stroke:#000000;stroke-width:2"/></clipPath></defs>' +
          `<g id="${G}" inkscape:groupmode="layer" inkscape:label="L1" transform="translate(10 20)" clip-path="url(#clipPath7)">` +
          '<rect width="9" height="9"/><g inkscape:groupmode="layer" inkscape:label="Sub"><rect width="2" height="2"/></g></g>',
      ),
    );
    expect(file.warnings).toEqual([]);
    const layer = byId(file, G);
    expect(children(file, layer?.id)).toMatchObject([
      { type: "rect", x: 10, y: 20 },
      { type: "layer", name: "Sub" },
      {
        type: "rect",
        x: 10,
        y: 20,
        width: 4,
        clipping: true,
        appearance: { fills: [], strokes: [] },
      },
    ]);
  });

  it("takes clip-path none, as Inkscape's Release writes it, as no clip", () => {
    const file = parseFile(svg("", '<g clip-path="none"><rect width="5" height="5"/></g>'));
    expect(file.warnings).toEqual([]);
  });
});

describe("a painted Clipping Path (ADR-0051)", () => {
  /** A Group with a Fill below Contents clipping a rect by a turned ellipse, painted as `look` says. */
  function framed(look: { strokes: boolean; above?: boolean }) {
    const { doc, defaultLayerId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 100, height: 100 }],
    });
    const [content, clip] = createNodes(doc, [
      { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 60, height: 60 },
      { type: "ellipse", parentId: defaultLayerId, x: 10, y: 10, width: 40, height: 20 },
    ]).nodes as [ShapeNode, ShapeNode];
    transformNodes(doc, {
      nodeIds: [clip.id],
      matrix: [0, 1, -1, 0, 0, 0],
      pivot: { x: 30, y: 20 },
    });
    const { group } = makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
    const stops = [
      { offset: 0, color: "#000000" },
      { offset: 1, color: "#FFFFFF80" },
    ];
    const gradient = {
      type: "linear" as const,
      stops,
      start: { x: 10, y: 0 },
      end: { x: 50, y: 0 },
    };
    const stroke = { cap: "butt" as const, join: "miter" as const, miterLimit: 10, dash: [] };
    const fills: Fill[] = [
      { type: "gradient", gradient },
      { type: "solid", color: "#00FF00" },
    ];
    const strokes = look.strokes
      ? [
          { type: "solid" as const, color: "#FF0000", width: 4, ...stroke },
          { type: "gradient" as const, gradient, width: 1, ...stroke, dash: [2, 1] },
        ]
      : [];
    const painted = doc.nodes.get(clip.id) as ShapeNode;
    doc.nodes.set(clip.id, {
      ...painted,
      appearance: { fills, strokes },
      opacity: 0.5,
      blendMode: "multiply",
    });
    const around = [{ type: "solid" as const, color: "#0000FF" }];
    // The index an Open numbers it with.
    doc.nodes.set(group.id, {
      ...group,
      index: "a0",
      appearance: look.above
        ? { fills: around, strokes: [{ ...strokes[0], color: "#FF00FF" } as never], contents: 1 }
        : { fills: around, strokes: [], contents: 1 },
    });
    return { doc, group, clip };
  }
  const opened = (doc: ReturnType<typeof framed>["doc"], xml: string) => {
    const file = parseSvg(xml);
    return { file, doc: { ...doc, nodes: new Map(file.nodes.map((n) => [n.id, n])) } };
  };
  const same = (a: ReturnType<typeof framed>["doc"], b: typeof a) =>
    expect(JSON.parse(serializeDocument(b))).toEqual(JSON.parse(serializeDocument(a)));

  it.each([
    ["Fills only, in one clipped <g>", { strokes: false }],
    ["Strokes, in a wrapper", { strokes: true }],
    ["Strokes and a container paint above, in two wrappers", { strokes: true, above: true }],
  ])(
    "reads back its Appearance, opacity and blend mode from %s: Open of an export is the Document",
    (_, look) => {
      const { doc } = framed(look);
      const { file, doc: back } = opened(doc, toSvg(doc));
      expect(file.warnings).toEqual([]);
      same(doc, back);
    },
  );

  it("reads back a stroked Layer Clipping Mask, its sublayer still a Layer (ADR-0053)", () => {
    const { doc } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 50, height: 50 }],
    });
    const [layer] = createNodes(doc, [{ type: "layer", name: "L" }]).nodes as [ShapeNode];
    const [sub, ellipse] = createNodes(doc, [
      { type: "layer", parentId: layer.id, name: "Sub" },
      { type: "ellipse", parentId: layer.id, x: 2, y: 2, width: 30, height: 20 },
    ]).nodes as [ShapeNode, ShapeNode];
    transformNodes(doc, { nodeIds: [ellipse.id], rotate: 30 });
    createNodes(doc, [{ type: "rect", parentId: sub.id, x: 0, y: 0, width: 40, height: 40 }]);
    const [clip] = makeMask(doc, { layerId: layer.id }).updated as [ShapeNode];
    const appearance = {
      fills: [{ type: "solid" as const, color: "#00FF00" }],
      strokes: [
        {
          type: "solid" as const,
          color: "#FF0000",
          width: 4,
          cap: "butt" as const,
          join: "miter" as const,
          miterLimit: 10,
          dash: [],
        },
      ],
    };
    doc.nodes.set(clip.id, { ...clip, appearance });
    const xml = toSvg(doc);
    expect(xml).toContain("kalamo:clipped");
    const { file, doc: back } = opened(doc as never, xml);
    expect(file.warnings).toEqual([]);
    same(doc as never, back);
  });

  it("ignores the ids Inkscape adds to the wrappers and copies when it saves", () => {
    const { doc } = framed({ strokes: true, above: true });
    let n = 0;
    const saved = toSvg(doc).replace(
      /<g kalamo:clipped="true"|(kalamo:paint="clip-[a-z]+"[^>]*>)(<[a-z]+)/g,
      (_, paint?: string, tag?: string) =>
        paint ? `${paint}${tag} id="copy${n++}"` : `<g id="g${n++}" kalamo:clipped="true"`,
    );
    expect(n).toBe(4);
    const { file, doc: back } = opened(doc, saved);
    expect(file.warnings).toEqual([]);
    same(doc, back);
  });

  it("loses the Strokes when their paint group is deleted, and the opacity with both", () => {
    const { doc, clip } = framed({ strokes: true });
    const xml = toSvg(doc);
    const noStroke = xml.replace(
      /<defs>(?:(?!<defs>).)*<\/defs><g kalamo:paint="clip-stroke".*?<\/g><\/g>/,
      "",
    );
    expect(noStroke).not.toContain("clip-stroke");
    const one = opened(doc, noStroke).doc.nodes.get(clip.id) as ShapeNode;
    expect(one).toMatchObject({ opacity: 0.5, blendMode: "multiply" });
    expect(one.appearance.strokes).toEqual([]);
    expect(one.appearance.fills).toHaveLength(2);
    const bare = noStroke.replace(
      /<defs>(?:(?!<defs>).)*<\/defs><g kalamo:paint="clip-fill".*?<\/g><\/g>/,
      "",
    );
    expect(opened(doc, bare).doc.nodes.get(clip.id)).toMatchObject({
      opacity: 1,
      blendMode: "normal",
      appearance: { fills: [], strokes: [] },
    });
  });

  it("keeps the first clip, with a warning, when the wrappers disagree", () => {
    const file = parseFile(
      svg(
        "",
        '<defs><clipPath id="b"><rect width="2" height="2"/></clipPath></defs>' +
          '<g><g kalamo:clipped="true" clip-path="url(#a)"><clipPath id="a"><rect width="1" height="1"/></clipPath><rect width="5" height="5"/></g>' +
          '<g kalamo:clipped="true" clip-path="url(#b)"><rect width="6" height="6"/></g></g>',
      ),
    );
    expect(file.warnings).toMatchObject([{ code: "UNSUPPORTED_ATTRIBUTE" }]);
    const clips = file.nodes.filter((n) => "clipping" in n);
    expect(clips).toMatchObject([{ type: "rect", width: 1 }]);
    const group = file.nodes.find((n) => n.id === clips[0]?.parentId);
    expect(file.nodes.filter((n) => n.parentId === group?.id)).toHaveLength(3);
  });

  describe("a text Clipping Path (ADR-0052)", () => {
    it("reads back a painted Area Type clip, its ranges, Range Fills and Strokes and overflow", () => {
      const { doc, defaultLayerId: parentId } = createDocument({
        id: "d",
        name: "Doc",
        artboards: [{ width: 100, height: 100 }],
      });
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
          content: "one\ntwo",
        },
      ]).nodes as [Node, Node];
      makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
      const text = doc.nodes.get(clip.id) as Node;
      const look = {
        transform: [0.9, 0.2, -0.2, 0.9, 5, 0],
        ranges: [
          { start: 0, end: 1, fill: "#FF0000" },
          { start: 1, end: 2, rotation: 10, stroke: "#00FF00" },
          { start: 5, end: 6, fill: "#FF0000", stroke: "#00FF00" },
        ],
        appearance: {
          fills: [{ type: "solid", color: "#000000" }],
          strokes: [
            {
              type: "solid",
              color: "#0000FF",
              width: 1,
              cap: "butt",
              join: "miter",
              miterLimit: 10,
              dash: [],
            },
          ],
        },
      };
      doc.nodes.set(clip.id, { ...text, ...look } as unknown as Node);
      const file = parseSvg(toSvg(doc));
      expect(file.warnings).toEqual([]);
      expect(file.nodes.find((n) => n.id === clip.id)).toMatchObject({
        type: "text",
        kind: "area",
        content: "one\ntwo",
        clipping: true,
        height: 20,
        ...look,
      });
    });

    it("reads Inkscape's Set Clip on a text, ignoring the paint left inside the <clipPath>", () => {
      const file = parseFile(
        svg(
          "",
          '<defs><clipPath clipPathUnits="userSpaceOnUse" id="clipPath7"><text id="text5" xml:space="preserve" transform="rotate(10)" style="font-size:20px;font-family:\'Source Sans 3\';fill:#000000"><tspan sodipodi:role="line" x="10" y="40">H<tspan style="fill:#ff0000" rotate="5">i</tspan></tspan></text></clipPath></defs>' +
            '<rect id="z-01J00000000000000000000R01" clip-path="url(#clipPath7)" width="50" height="50" fill="#00ff00"/>',
        ),
      );
      expect(file.warnings).toEqual([]);
      const rect = file.nodes.find((n) => n.id === "01J00000000000000000000R01");
      expect(file.nodes.filter((n) => n.parentId === rect?.parentId)).toMatchObject([
        { type: "rect" },
        {
          type: "text",
          content: "Hi",
          fontSize: 20,
          clipping: true,
          ranges: [{ start: 1, end: 2, rotation: 5 }],
          appearance: { fills: [], strokes: [] },
        },
      ]);
    });
  });

  it("drops a clip paint group whose Group has no Clipping Path, with a warning", () => {
    const paint =
      '<g kalamo:paint="clip-stroke"><rect width="5" height="5" fill="none" stroke="red"/></g>';
    for (const body of [`<g><rect width="5" height="5"/>${paint}</g>`, paint]) {
      const file = parseFile(svg("", body));
      expect(file.warnings).toMatchObject([{ code: "UNSUPPORTED_ELEMENT" }]);
      expect(file.nodes.filter((n) => n.type === "rect")).toHaveLength(
        1 - (body === paint ? 1 : 0),
      );
    }
  });
});

describe("Illustrator's <use> clips (ADR-0056)", () => {
  const ai = (body: string) => svg('xmlns:xlink="http://www.w3.org/1999/xlink"', body);
  const clips = (file: ReturnType<typeof parseFile>) => file.nodes.filter((n) => "clipping" in n);
  const kids = (file: ReturnType<typeof parseFile>, id: string | undefined) =>
    file.nodes.filter((n) => n.parentId === id).sort((a, b) => (a.index < b.index ? -1 : 1));
  /** A `<g>` clipped through `use`, whose target `target` is in `<defs>`. */
  const clipped = (target: string, use = 'xlink:href="#s" style="overflow:visible;"') =>
    parseFile(
      ai(
        `<defs>${target}</defs><clipPath id="c"><use ${use}/></clipPath>` +
          '<g id="z-01J00000000000000000000G01" clip-path="url(#c)"><rect width="100" height="100" fill="red"/></g>',
      ),
    );

  it.each([
    ['<rect id="s" x="10" y="10" width="50" height="40"/>', { type: "rect", x: 10, width: 50 }],
    [
      '<path id="s" d="M10 10 H60 V50 H10 Z"/>',
      { type: "path", d: "M 10 10 L 60 10 L 60 50 L 10 50 Z" },
    ],
    [
      '<polygon id="s" points="10,10 60,10 60,50"/>',
      { type: "path", d: "M 10 10 L 60 10 L 60 50 Z" },
    ],
    ['<ellipse id="s" cx="35" cy="30" rx="25" ry="20"/>', { type: "ellipse", x: 10, width: 50 }],
  ])("reads a <use> of %s as an unpainted Clipping Path on top", (target, shape) => {
    const file = clipped(target);
    expect(file.warnings).toEqual([]);
    const group = file.nodes.find((n) => n.id === "01J00000000000000000000G01");
    expect(kids(file, group?.id)).toMatchObject([
      { type: "rect", width: 100 },
      { ...shape, clipping: true, appearance: { fills: [], strokes: [] } },
    ]);
  });

  it.each([
    ["presentation attributes", 'xlink:href="#s" overflow="visible"'],
    ["SVG 2's href", 'href="#s"'],
    ["Inkscape's re-save", 'id="use7" xlink:href="#s" x="0" y="0" width="100%" height="100%"'],
  ])("holds the <use> form with %s", (_, use) => {
    const file = clipped('<rect id="s" x="10" y="10" width="50" height="40"/>', use);
    expect(file.warnings).toEqual([]);
    expect(clips(file)).toMatchObject([{ type: "rect", x: 10, y: 10, width: 50, height: 40 }]);
  });

  it("draws the copy in the element's space, then the <clipPath>'s, the <use>'s, x and y and the target's own transform", () => {
    const file = parseFile(
      ai(
        '<defs><g transform="translate(999 999)"><rect id="s" width="10" height="10" transform="rotate(90)"/></g></defs>' +
          '<clipPath id="c" transform="translate(100 0)"><use xlink:href="#s" transform="scale(2)" x="5" y="0"/></clipPath>' +
          '<g transform="translate(0 50)" clip-path="url(#c)"><rect width="5" height="5"/></g>',
      ),
    );
    expect(file.warnings).toEqual([]);
    expect(clips(file)).toMatchObject([
      { type: "rect", x: 0, y: 0, width: 10, height: 10, transform: [0, 2, -2, 0, 110, 50] },
    ]);
  });

  it("takes clip-rule from the <use>, the target's own first, and ignores the target's paint", () => {
    const path = (attrs: string) => `<path id="s" d="M0 0 H9 V9 Z" ${attrs}/>`;
    const evenodd = clipped(path('fill="red" stroke="blue"'), 'href="#s" clip-rule="evenodd"');
    expect(clips(evenodd)).toMatchObject([
      { fillRule: "evenodd", appearance: { fills: [], strokes: [] } },
    ]);
    const own = clipped(path('clip-rule="nonzero"'), 'href="#s" clip-rule="evenodd"');
    expect(clips(own)).toMatchObject([{ fillRule: "nonzero" }]);
  });

  it("names the Clipping Path after the <use>: its z-<ULID> id and label, any other id new", () => {
    const rect = '<rect id="s" width="9" height="9"/>';
    const kept = clipped(
      rect,
      'id="z-01J00000000000000000000C01" inkscape:label="Frame" href="#s"',
    );
    expect(clips(kept)).toMatchObject([{ id: "01J00000000000000000000C01", name: "Frame" }]);
    const fresh = clipped(
      '<rect id="z-01J00000000000000000000S01" width="9" height="9"/>',
      'id="SVGID_1_" href="#z-01J00000000000000000000S01"',
    );
    const [clip] = clips(fresh);
    expect(clip?.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(clip?.id).not.toBe("01J00000000000000000000S01");
  });

  it("still draws a target in the content, and gives each clip of one target its own Clipping Path", () => {
    const file = parseFile(
      ai(
        '<rect id="s" x="1" y="1" width="9" height="9" fill="blue"/>' +
          '<clipPath id="a"><use href="#s"/></clipPath><clipPath id="b"><use href="#s"/></clipPath>' +
          '<g clip-path="url(#a)"><rect width="5" height="5"/></g><g clip-path="url(#b)"><rect width="6" height="6"/></g>',
      ),
    );
    expect(file.warnings).toEqual([]);
    expect(file.nodes.filter((n) => n.type === "rect" && n.x === 1)).toMatchObject([
      { appearance: { fills: [{ color: "#0000FF" }] } },
      { clipping: true },
      { clipping: true },
    ]);
    const [a, b] = clips(file);
    expect(a?.parentId).not.toBe(b?.parentId);
  });

  it("clips by a target text's glyphs, without its Range Fills (ADR-0052)", () => {
    const file = clipped(
      '<text id="s" x="0" y="20" style="font-size:20px">H<tspan fill="red" rotate="5">i</tspan></text>',
      'href="#s"',
    );
    expect(file.warnings).toEqual([]);
    expect(clips(file)).toMatchObject([
      {
        type: "text",
        content: "Hi",
        fontSize: 20,
        ranges: [{ start: 1, end: 2, rotation: 5 }],
        appearance: { fills: [], strokes: [] },
      },
    ]);
  });

  it.each([
    ["a missing target", '<rect id="s" width="9" height="9"/>', 'href="#nope"'],
    ["a <g>", '<g id="s"><rect width="9" height="9"/></g>', 'href="#s"'],
    ["a <symbol>", '<symbol id="s"><rect width="9" height="9"/></symbol>', 'href="#s"'],
    ["a <use>", '<rect id="r" width="9" height="9"/><use id="s" href="#r"/>', 'href="#s"'],
    ["itself", "", 'id="u" href="#u"'],
    ["its own <clipPath>", "", 'href="#c"'],
    ["another file", '<rect id="s" width="9" height="9"/>', 'href="other.svg#s"'],
    ["a clipped target", '<rect id="s" width="9" height="9" clip-path="url(#c)"/>', 'href="#s"'],
    ["a clipped <use>", '<rect id="s" width="9" height="9"/>', 'href="#s" clip-path="url(#c)"'],
    ["a percentage x", '<rect id="s" width="9" height="9"/>', 'href="#s" x="10%"'],
    ["a text on a path", '<text id="s"><textPath href="#p">Hi</textPath></text>', 'href="#s"'],
  ])(
    "imports unclipped, with one clip-path warning naming <use>, a <use> of %s",
    (_, target, use) => {
      const file = clipped(target, use);
      expect(file.warnings).toMatchObject([
        { code: "UNSUPPORTED_ATTRIBUTE", message: expect.stringContaining("<use>") },
      ]);
      expect(clips(file)).toEqual([]);
    },
  );

  it.each([
    ["objectBoundingBox units", 'clipPathUnits="objectBoundingBox"', '<use href="#s"/>'],
    ["a second shape", "", '<use href="#s"/><rect width="1" height="1"/>'],
  ])("imports unclipped a <use> clip with %s", (_, attrs, inner) => {
    const file = parseFile(
      ai(
        `<defs><rect id="s" width="9" height="9"/></defs><clipPath id="c" ${attrs}>${inner}</clipPath>` +
          '<g clip-path="url(#c)"><rect width="100" height="100"/></g>',
      ),
    );
    expect(file.warnings).toMatchObject([{ code: "UNSUPPORTED_ATTRIBUTE" }]);
    expect(clips(file)).toEqual([]);
  });

  /** Illustrator's Save As SVG Clip Group: a clipPath in the <g>, named by each of its children. */
  const illustrator = (children: string, attrs = "") =>
    parseFile(
      ai(
        `<g id="z-01J00000000000000000000G01" ${attrs}><defs><rect id="SVGID_1_" x="10" y="10" width="50" height="40"/></defs>` +
          '<clipPath id="SVGID_2_"><use xlink:href="#SVGID_1_" style="overflow:visible;"/></clipPath>' +
          '<clipPath id="other"><rect width="1" height="1"/></clipPath>' +
          `${children}</g>`,
      ),
    );
  const by = (clip: string, extra = "") => `style="clip-path:url(#${clip});" ${extra}`;
  const three = (last = by("SVGID_2_")) =>
    `<g ${by("SVGID_2_")}><rect width="30" height="30" fill="#f00"/></g>` +
    `<polygon ${by("SVGID_2_")} points="0,0 100,0 100,100"/>` +
    `<rect ${last} x="50" width="50" height="50"/>`;

  it("merges Illustrator's per-child clips into one Clip Group, its Clipping Path on top, rounding matrices included", () => {
    const rounding = 'transform="matrix(1 0 2.980232e-08 1 -3.051758e-05 -3.051758e-05)"';
    const file = illustrator(three(by("SVGID_2_", rounding)));
    expect(file.warnings).toEqual([]);
    const group = file.nodes.find((n) => n.id === "01J00000000000000000000G01");
    expect(kids(file, group?.id)).toMatchObject([
      { type: "group" },
      { type: "path" },
      { type: "rect", x: 50 },
      { type: "rect", x: 10, y: 10, width: 50, height: 40, clipping: true },
    ]);
    expect(clips(file)).toHaveLength(1);
    expect(file.nodes.filter((n) => n.type === "group")).toHaveLength(2);
  });

  it.each([
    ["one child names another clip", three(by("other")), "", 3],
    ["one child is unclipped", three(""), "", 2],
    ["one child has a real transform", three(by("SVGID_2_", 'transform="translate(1 0)"')), "", 3],
    ["it is an Inkscape layer", three(), 'inkscape:groupmode="layer"', 3],
    [
      "it has a <g kalamo:clipped> wrapper",
      `<g kalamo:clipped="true" clip-path="url(#other)">${three()}</g>`,
      "",
      4,
    ],
  ])("keeps a Clip Group per clipped child when %s", (_, children, attrs, count) => {
    const file = illustrator(children, attrs);
    expect(file.warnings).toEqual([]);
    expect(clips(file)).toHaveLength(count);
    const shared = clips(file).filter((c) => c.type === "rect" && c.width === 50);
    expect(shared.every((c) => c.parentId !== "01J00000000000000000000G01")).toBe(true);
  });

  /** Illustrator's painted Clip Group: a Fill <use> before the clipped content, a Stroke <use> after. */
  const painted = (before: string, after: string, between = "") =>
    parseFile(
      ai(
        '<linearGradient id="grad" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="60" y2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>' +
          '<g><defs><rect id="S" x="10" y="10" width="50" height="40"/></defs>' +
          `<use xlink:href="#S" style="overflow:visible;${before}"/>` +
          '<clipPath id="C"><use xlink:href="#S" style="overflow:visible;"/></clipPath>' +
          '<rect style="clip-path:url(#C);fill:#f00" width="30" height="100"/>' +
          between +
          '<rect style="clip-path:url(#C);fill:#f00" x="40" width="30" height="100"/>' +
          `<use xlink:href="#S" style="overflow:visible;${after}"/></g>`,
      ),
    );
  const gradient = {
    type: "gradient",
    gradient: { type: "linear", start: { x: 10 }, end: { x: 60 } },
  };

  it("paints the Clipping Path with the Fill <use> before and the Stroke <use> after, gradients included", () => {
    const file = painted(
      "fill:url(#grad);opacity:0.5;",
      "fill:none;stroke:url(#grad);stroke-width:4;stroke-miterlimit:10;",
    );
    expect(file.warnings).toEqual([]);
    expect(file.nodes.filter((n) => n.type !== "layer")).toMatchObject([
      { type: "group" },
      { type: "rect", x: 0 },
      { type: "rect", x: 40 },
      {
        type: "rect",
        x: 10,
        clipping: true,
        opacity: 0.5,
        appearance: { fills: [gradient], strokes: [{ ...gradient, width: 4, miterLimit: 10 }] },
      },
    ]);
  });

  it("drops a paint <use> out of ADR-0051's order with a clip-path paint warning", () => {
    const file = painted(
      "fill:#0f0;stroke:#00f;",
      "fill:#f0f;stroke:#000;",
      '<use xlink:href="#S" style="fill:#ff0"/>',
    );
    expect(file.warnings).toMatchObject([
      { code: "UNSUPPORTED_ATTRIBUTE", message: expect.stringContaining("paint") },
    ]);
    expect(clips(file)).toMatchObject([
      { appearance: { fills: [{ color: "#00FF00" }], strokes: [{ color: "#000000" }] } },
    ]);
    expect(file.nodes.filter((n) => n.type === "rect")).toHaveLength(3);
  });

  it("drops any other drawn <use> as UNSUPPORTED_ELEMENT", () => {
    for (const body of [
      '<rect id="s" width="9" height="9"/><use href="#s" x="20"/>',
      '<g><defs><rect id="s" width="9" height="9"/></defs><clipPath id="c"><use href="#s"/></clipPath><use href="#s" x="1"/><rect clip-path="url(#c)" width="5" height="5"/></g>',
    ]) {
      expect(parseFile(ai(body)).warnings).toMatchObject([
        { code: "UNSUPPORTED_ELEMENT", message: expect.stringContaining("<use>") },
      ]);
    }
  });

  it("holds Illustrator's Export As form: a class-set clip-path and the shape in the <clipPath>", () => {
    const file = parseFile(
      ai(
        "<defs><style>.cls-1{fill:none;}.cls-2{clip-path:url(#clip-path);}</style>" +
          '<clipPath id="clip-path"><polygon class="cls-1" points="10,10 60,10 60,50"/></clipPath></defs>' +
          '<g class="cls-2"><rect width="100" height="100"/></g>',
      ),
    );
    expect(file.warnings).toEqual([]);
    expect(clips(file)).toMatchObject([{ type: "path", appearance: { fills: [] } }]);
  });

  it("reads an Inkscape layer clipped through a <use> as a Layer Clipping Mask, its Clipping Path on top (ADR-0053)", () => {
    const file = parseFile(
      ai(
        '<defs><rect id="s" x="1" y="1" width="9" height="9"/><clipPath id="c"><use href="#s"/></clipPath></defs>' +
          '<g id="z-01J00000000000000000000G01" inkscape:groupmode="layer" clip-path="url(#c)"><rect width="5" height="5"/></g>',
      ),
    );
    expect(file.warnings).toEqual([]);
    expect(kids(file, "01J00000000000000000000G01")).toMatchObject([
      { type: "rect", width: 5 },
      { type: "rect", x: 1, clipping: true },
    ]);
    expect(file.nodes.find((n) => n.id === "01J00000000000000000000G01")).toMatchObject({
      type: "layer",
    });
  });

  it("keeps an inline <use> clip at its place in a layer (ADR-0053)", () => {
    const file = parseFile(
      ai(
        '<defs><rect id="s" x="1" y="1" width="9" height="9"/></defs>' +
          '<g id="z-01J00000000000000000000G01" inkscape:groupmode="layer" clip-path="url(#c)"><rect width="5" height="5"/>' +
          '<clipPath id="c"><use id="z-01J00000000000000000000C01" href="#s"/></clipPath><rect width="6" height="6"/></g>',
      ),
    );
    expect(file.warnings).toEqual([]);
    expect(kids(file, "01J00000000000000000000G01")).toMatchObject([
      { width: 5 },
      { id: "01J00000000000000000000C01", x: 1, clipping: true },
      { width: 6 },
    ]);
  });

  it("exports the inline form, which reads back as the same Nodes", () => {
    const file = painted("fill:url(#grad);", "fill:none;stroke:#000;stroke-width:4;");
    const { doc } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 100, height: 100 }],
    });
    const opened = { ...doc, nodes: new Map(file.nodes.map((n) => [n.id, n])) };
    const xml = toSvg(opened);
    expect(xml).not.toContain("<use");
    const back = parseSvg(xml);
    expect(back.warnings).toEqual([]);
    expect(
      JSON.parse(serializeDocument({ ...doc, nodes: new Map(back.nodes.map((n) => [n.id, n])) })),
    ).toEqual(JSON.parse(serializeDocument(opened)));
  });
});

describe("<image>", () => {
  const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
  const open = (body: string) => parseSvg(svg(`width="100" height="100" ${XLINK}`, body));
  const images = (file: ReturnType<typeof parseSvg>) =>
    file.nodes.filter((n): n is ImageNode => n.type === "image");

  it("reads Inkscape's embedded image: its frame, preserveAspectRatio and file", () => {
    const file = open(
      `<image x="5" y="6" width="30" height="20" preserveAspectRatio="xMidYMid slice" xlink:href="${RED_2x2_PNG}"/>`,
    );
    const [image] = images(file);
    expect(image).toMatchObject({
      x: 5,
      y: 6,
      width: 30,
      height: 20,
      preserveAspectRatio: "xMidYMid slice",
      src: "pending:0",
    });
    expect(image).not.toHaveProperty("appearance");
    expect(file.images.get("pending:0")).toMatchObject({ mime: "image/png", width: 2, height: 2 });
    expect(file.warnings).toEqual([]);
  });

  it("reads SVG 2's href, takes a missing size from the file and SVG's own default alignment", () => {
    const [image] = images(open(`<image href="${RED_2x2_PNG}"/>`));
    expect(image).toMatchObject({
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      preserveAspectRatio: "xMidYMid meet",
    });
  });

  it("drops defer, and bakes a move and uniform scale into the frame", () => {
    const [image] = images(
      open(
        `<image transform="translate(10 20) scale(2)" width="4" height="3" preserveAspectRatio="defer xMinYMin" href="${RED_2x2_PNG}"/>`,
      ),
    );
    expect(image).toMatchObject({
      x: 10,
      y: 20,
      width: 8,
      height: 6,
      preserveAspectRatio: "xMinYMin meet",
      transform: [1, 0, 0, 1, 0, 0],
    });
  });

  it("gives two copies of one file one key", () => {
    const body = `<image href="${RED_2x2_PNG}"/><image x="5" href="${RED_2x2_PNG}"/>`;
    const file = open(body);
    expect(images(file).map((n) => n.src)).toEqual(["pending:0", "pending:0"]);
    expect([...file.images.keys()]).toEqual(["pending:0"]);
  });

  it("reads a linked image as a missing link: its trimmed href as file, the frame as embedded", () => {
    const file = open(
      `<image transform="translate(10 20) scale(2)" width="4" height="3" preserveAspectRatio="xMinYMin slice" xlink:href=" photos/a b.png " sodipodi:absref="/home/me/photos/a b.png"/><image href="https://example.com/b.jpg" width="1" height="1"/>`,
    );
    const [a, b] = images(file);
    expect(a).toMatchObject({
      file: "photos/a b.png",
      x: 10,
      y: 20,
      width: 8,
      height: 6,
      preserveAspectRatio: "xMinYMin slice",
    });
    expect(a).not.toHaveProperty("src");
    expect(b).toMatchObject({
      file: "https://example.com/b.jpg",
      preserveAspectRatio: "xMidYMid meet",
    });
    expect(file.images.size).toBe(0);
    expect(file.warnings).toEqual([expect.objectContaining({ code: "IMAGE_LINK_MISSING" })]);
  });

  const ID = "a".repeat(64);
  const PIXELS = { mime: "image/png" as const, width: 2, height: 3 };

  it("gives a linked image its kalamo:src only when the Document holds that image", () => {
    const body = `<image width="4" height="3" href="a.png" kalamo:src="${ID}"/><image width="4" height="3" href="b.png" kalamo:src="${"b".repeat(64)}"/>`;
    const file = open(body);
    expect(images(file).map((n) => n.src)).toEqual([undefined, undefined]);
    // Unresolved, both are missing links.
    expect(file.warnings).toEqual([expect.objectContaining({ code: "IMAGE_LINK_MISSING" })]);

    const held = resolveLinks(file, (id) => (id === ID ? PIXELS : undefined));
    expect(images(held).map((n) => [n.file, n.src])).toEqual([
      ["a.png", ID],
      ["b.png", undefined],
    ]);
    expect(held.warnings).toEqual([expect.objectContaining({ code: "IMAGE_LINK_MISSING" })]);
    expect(
      images(resolveLinks(open(body.slice(0, body.indexOf("/>") + 2)), () => PIXELS)),
    ).toMatchObject([{ src: ID }]);
    expect(resolveLinks(open(body), () => PIXELS).warnings).toEqual([]);
  });

  it("sizes an unsized linked image from its resolved pixels, and drops it without them", () => {
    const body = `<image transform="scale(2)" width="5" href="a.png" kalamo:src="${ID}"/>`;
    const [image] = images(resolveLinks(open(body), () => PIXELS));
    expect(image).toMatchObject({ src: ID, width: 10, height: 6 });

    const missing = resolveLinks(open(body), () => undefined);
    expect(images(missing)).toEqual([]);
    expect(missing.warnings).toEqual([expect.objectContaining({ code: "INVALID_IMAGE" })]);

    const clipped = resolveLinks(
      open(
        `<defs><clipPath id="c"><rect width="1" height="1"/></clipPath></defs><image clip-path="url(#c)" href="a.png" kalamo:src="${ID}"/>`,
      ),
      () => undefined,
    );
    expect(clipped.nodes.map((n) => n.type)).toEqual(["layer"]);
  });

  it("keeps a Layer left with only its Clipping Path by a dropped image (ADR-0053)", () => {
    const file = resolveLinks(
      open(
        `<defs><clipPath id="c"><rect width="1" height="1"/></clipPath></defs><g id="z-01J00000000000000000000L01" inkscape:groupmode="layer" clip-path="url(#c)"><image href="a.png" kalamo:src="${ID}"/></g>`,
      ),
      () => undefined,
    );
    expect(file.nodes.map((n) => [n.type, "clipping" in n])).toEqual([
      ["layer", false],
      ["rect", true],
    ]);
  });

  it("drops a linked image with a negative or zero size silently, as SVG draws nothing", () => {
    const file = open('<image href="a.png" width="-5" height="3"/><image href="b.png" width="0"/>');
    expect(images(file)).toEqual([]);
    expect(file.warnings).toEqual([]);
  });

  it.each([
    ["a linked file without width", '<image href="photo.png" height="1"/>', "INVALID_IMAGE"],
    ["an empty href", '<image href=" " width="1" height="1"/>', "INVALID_IMAGE"],
    ["a WebP", `<image href="${WEBP_HEADER}" width="1" height="1"/>`, "INVALID_IMAGE"],
  ])("drops %s with a warning", (_, body, code) => {
    const file = open(body);
    expect(images(file)).toEqual([]);
    expect(file.images.size).toBe(0);
    expect(file.warnings).toEqual([expect.objectContaining({ code })]);
  });

  it("makes an image clipped by Inkscape's Set Clip a Clipping Mask", () => {
    const file = open(
      `<defs><clipPath id="c"><rect x="1" y="1" width="2" height="2"/></clipPath></defs><image clip-path="url(#c)" width="4" height="4" href="${RED_2x2_PNG}"/>`,
    );
    const group = file.nodes.find((n) => n.type === "group");
    expect(file.nodes.filter((n) => n.parentId === group?.id).map((n) => n.type)).toEqual([
      "image",
      "rect",
    ]);
    expect(file.warnings).toEqual([]);
  });

  it("caps an SVG at 5 MB outside its embedded images", () => {
    const png = readImage(RED_2x2_PNG, "src").bytes;
    const big = new Uint8Array(4 * 1024 * 1024);
    big.set(png);
    const url = `data:image/png;base64,${big.toBase64()}`;
    expect(url.length).toBeGreaterThan(SVG_LIMIT);
    expect(
      parseFile(svg(XLINK, `<image width="1" height="1" xlink:href="${url}"/>`)).nodes,
    ).toContainEqual(expect.objectContaining({ type: "image" }));
    const markup = svg(
      XLINK,
      `<desc>${"x".repeat(SVG_LIMIT)}</desc><image href="${RED_2x2_PNG}"/>`,
    );
    expect(errorOf(() => parseFile(markup))).toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
});

describe("gradients (ADR-0026)", () => {
  const stops = [
    { offset: 0, color: "#1F5FBF" },
    { offset: 1, color: "#9FD0FF00" },
  ];
  const STOPS =
    '<stop offset="0" stop-color="#1F5FBF"/><stop offset="1" stop-color="#9FD0FF" stop-opacity="0"/>';
  /** The first Fill of the first leaf of `body`, and the file's warning codes. */
  const fillOf = (body: string, defs = "") => {
    const file = parseFile(svg('width="200" height="200"', `<defs>${defs}</defs>${body}`));
    const [leaf] = leaves(file);
    const fill = leaf && "appearance" in leaf ? leaf.appearance.fills[0] : undefined;
    return { fill, codes: file.warnings.map((w) => w.code) };
  };
  const gradientOf = (body: string, defs = "") => {
    const { fill } = fillOf(body, defs);
    if (fill?.type !== "gradient") throw new Error(`not a gradient: ${JSON.stringify(fill)}`);
    return fill.gradient;
  };

  it("reads back what toSvg writes: linear, elliptical radial, Stroke, text, stack and a turned Node", () => {
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "D",
      name: "Doc",
      artboards: [{ width: 200, height: 200 }],
    });
    const linear = { type: "gradient", gradient: { type: "linear", stops } } as const;
    const radial = (angle: number, aspectRatio: number) =>
      ({
        type: "gradient",
        gradient: { type: "radial", stops, aspectRatio, angle, focus: { x: 20, y: 22 } },
      }) as const;
    const { nodes } = createNodes(doc, [
      {
        type: "rect",
        parentId,
        x: 0,
        y: 0,
        width: 50,
        height: 30,
        appearance: { fills: [linear] },
      },
      {
        type: "ellipse",
        parentId,
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        appearance: { fills: [radial(30, 0.5)], strokes: [{ ...radial(200, 2.5), width: 3 }] },
      },
      { type: "text", parentId, x: 10, y: 100, content: "Hi", appearance: { fills: [linear] } },
      {
        type: "line",
        parentId,
        x1: 0,
        y1: 150,
        x2: 100,
        y2: 150,
        appearance: { fills: [{ color: "#FF0000" }, linear], strokes: [linear] },
      },
      {
        type: "rect",
        parentId,
        x: 100,
        y: 0,
        width: 50,
        height: 30,
        appearance: { fills: [linear] },
      },
    ]);
    const turned = nodes[4];
    if (!turned) throw new Error("setup");
    doc.nodes.set(turned.id, { ...turned, transform: [0.866025, 0.5, -0.5, 0.866025, 10, 5] });
    const read = parseSvg(toSvg(doc));
    expect(read.warnings).toEqual([]);
    for (const n of nodes) {
      const back = read.nodes.find((r) => r.id === n.id);
      expect(back && "appearance" in back && back.appearance).toEqual(
        "appearance" in n && n.appearance,
      );
    }
  });

  it("follows href for stops and each attribute, and folds stop-opacity and fill-opacity in", () => {
    const g = gradientOf(
      '<rect x="0" y="0" width="10" height="10" fill="url(#pos)" fill-opacity=".5"/>',
      `<linearGradient id="vec"><stop offset="0" stop-color="red" stop-opacity=".5"/><stop offset="1" style="stop-color:#00F"/></linearGradient>` +
        '<linearGradient id="mid" href="#vec" gradientUnits="userSpaceOnUse" x2="100"/>' +
        '<linearGradient id="pos" xlink:href="#mid" x1="20" y1="5" y2="5" xmlns:xlink="http://www.w3.org/1999/xlink"/>',
    );
    expect(g).toEqual({
      type: "linear",
      stops: [
        { offset: 0, color: "#FF000040" },
        { offset: 1, color: "#0000FF80" },
      ],
      start: { x: 20, y: 5 },
      end: { x: 100, y: 5 },
    });
  });

  it("clamps offsets to 0-1 and never lets them decrease", () => {
    const g = gradientOf(
      '<rect width="10" height="10" fill="url(#g)"/>',
      '<linearGradient id="g"><stop offset="-1" stop-color="#000"/><stop offset="80%" stop-color="#111"/>' +
        '<stop offset=".5" stop-color="#222"/><stop offset="2" stop-color="#333"/></linearGradient>',
    );
    expect(g.stops.map((s) => s.offset)).toEqual([0, 0.8, 0.8, 1]);
  });

  it("moves and scales a userSpaceOnUse gradient with a baked leaf", () => {
    const g = gradientOf(
      '<rect transform="translate(5 5) scale(2)" width="10" height="10" fill="url(#g)"/>',
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="10">${STOPS}</linearGradient>`,
    );
    expect(g).toMatchObject({ start: { x: 5, y: 5 }, end: { x: 25, y: 5 } });
  });

  it("maps objectBoundingBox, SVG's default, through the element's box", () => {
    const g = gradientOf(
      '<rect x="5" y="5" width="10" height="20" fill="url(#g)"/>',
      `<linearGradient id="g">${STOPS}</linearGradient>`,
    );
    expect(g).toMatchObject({ start: { x: 5, y: 5 }, end: { x: 15, y: 5 } });
    // Diagonal in a 10 × 20 box: the stripes run corner to corner, so the vector is not.
    const d = gradientOf(
      '<rect x="0" y="0" width="10" height="20" fill="url(#g)"/>',
      `<linearGradient id="g" x2="1" y2="1">${STOPS}</linearGradient>`,
    );
    expect(d).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 16, y: 8 } });
  });

  it("uses the fallback colour when the box has no area", () => {
    const { fill } = fillOf(
      '<line x1="0" y1="5" x2="10" y2="5" stroke="none" fill="url(#g) #ABCDEF"/>',
      `<linearGradient id="g">${STOPS}</linearGradient>`,
    );
    expect(fill).toEqual({ type: "solid", color: "#ABCDEF" });
  });

  it("folds gradientTransform in: a turn, and a stretched radial becoming an ellipse", () => {
    const turned = gradientOf(
      '<rect width="100" height="100" fill="url(#g)"/>',
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" x2="30" gradientTransform="rotate(90)">${STOPS}</linearGradient>`,
    );
    expect(turned).toMatchObject({ start: { x: 0, y: 10 }, end: { x: 0, y: 30 } });
    const stretched = gradientOf(
      '<rect width="100" height="100" fill="url(#g)"/>',
      `<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="10" cy="10" r="5" fx="12" gradientTransform="scale(1 2)">${STOPS}</radialGradient>`,
    );
    expect(stretched).toEqual({
      type: "radial",
      stops,
      center: { x: 10, y: 20 },
      radius: 5,
      aspectRatio: 2,
      angle: 0,
      focus: { x: 12, y: 20 },
    });
  });

  it("keeps every stop's place under a skew", () => {
    const g = gradientOf(
      '<rect width="100" height="100" fill="url(#g)"/>',
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="10" gradientTransform="skewX(30)">${STOPS}</linearGradient>`,
    );
    if (g.type !== "linear") throw new Error("linear");
    // In gradient space t = x / 10; the skew maps (x, y) to (x + y tan 30, y).
    const t = (px: number, py: number) => {
      const [dx, dy] = [g.end.x - g.start.x, g.end.y - g.start.y];
      return ((px - g.start.x) * dx + (py - g.start.y) * dy) / (dx * dx + dy * dy);
    };
    const tan = Math.tan(Math.PI / 6);
    for (const [x, y] of [
      [5, 0],
      [5, 10],
      [10, 40],
    ] as const) {
      expect(t(x + y * tan, y)).toBeCloseTo(x / 10, 2);
    }
  });

  it.each([
    [
      "one stop",
      '<linearGradient id="g"><stop offset=".3" stop-color="#FF0000"/></linearGradient>',
      { type: "solid", color: "#FF0000" },
    ],
    [
      "no length",
      `<linearGradient id="g" x2="0">${STOPS}</linearGradient>`,
      { type: "solid", color: "#9FD0FF00" },
    ],
    [
      "r of 0",
      `<radialGradient id="g" r="0">${STOPS}</radialGradient>`,
      { type: "solid", color: "#9FD0FF00" },
    ],
    ["no stops", '<linearGradient id="g"/>', undefined],
  ])("paints a gradient with %s as SVG does", (_, defs, fill) => {
    expect(fillOf('<rect width="10" height="10" fill="url(#g)"/>', defs).fill).toEqual(fill);
  });

  it("unrolls repeat and reflect into stops over the element", () => {
    const two = '<stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#FFF"/>';
    const repeat = gradientOf(
      '<rect x="0" y="0" width="30" height="10" fill="url(#g)"/>',
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x2="10" spreadMethod="repeat">${two}</linearGradient>`,
    );
    const colors = (g: typeof repeat) => g.stops.map((s) => `${s.offset} ${s.color}`);
    expect(repeat).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 30, y: 0 } });
    expect(colors(repeat)).toEqual([
      "0 #000000",
      "0.333 #FFFFFF",
      "0.333 #000000",
      "0.667 #FFFFFF",
      "0.667 #000000",
      "1 #FFFFFF",
    ]);
    const reflect = gradientOf(
      '<rect x="-10" y="0" width="20" height="10" fill="url(#g)"/>',
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x2="10" spreadMethod="reflect">${two}</linearGradient>`,
    );
    expect(reflect).toMatchObject({ start: { x: -10, y: 0 }, end: { x: 10, y: 0 } });
    expect(colors(reflect)).toEqual(["0 #FFFFFF", "0.5 #000000", "0.5 #000000", "1 #FFFFFF"]);
    const radial = gradientOf(
      '<rect x="0" y="0" width="20" height="20" fill="url(#g)"/>',
      `<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="10" spreadMethod="repeat">${two}</radialGradient>`,
    );
    // The far corner is 2.83 radii out, so three periods.
    expect(radial).toMatchObject({ center: { x: 0, y: 0 }, radius: 30 });
    expect(radial.stops).toHaveLength(6);
    // Stops short of the ends hold their colours out to each period's edge.
    const inset = gradientOf(
      '<rect x="0" y="0" width="20" height="10" fill="url(#g)"/>',
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x2="10" spreadMethod="repeat"><stop offset=".3" stop-color="#000"/><stop offset="1" stop-color="#FFF"/></linearGradient>`,
    );
    expect(colors(inset)).toEqual([
      "0 #000000",
      "0.15 #000000",
      "0.5 #FFFFFF",
      "0.5 #000000",
      "0.65 #000000",
      "1 #FFFFFF",
    ]);
  });

  it("warns about fr and drops a pattern as before", () => {
    const { codes } = fillOf(
      '<rect width="10" height="10" fill="url(#g)"/><rect width="10" height="10" fill="url(#p)"/>',
      `<radialGradient id="g" fr=".2">${STOPS}</radialGradient><pattern id="p"/>`,
    );
    expect(codes.sort()).toEqual(["UNSUPPORTED_ATTRIBUTE", "UNSUPPORTED_PAINT"]);
  });

  it("reads Inkscape's split vector and positioned gradients, moved after saving, as one", () => {
    const g = gradientOf(
      '<rect x="0" y="0" width="100" height="50" style="fill:url(#linearGradient2)"/>',
      '<linearGradient id="linearGradient1" inkscape:collect="always"><stop style="stop-color:#1f5fbf;stop-opacity:1" offset="0"/>' +
        '<stop style="stop-color:#9fd0ff;stop-opacity:0" offset="1"/></linearGradient>' +
        '<linearGradient inkscape:collect="always" xlink:href="#linearGradient1" id="linearGradient2" x1="0" y1="25" x2="100" y2="25" ' +
        'gradientUnits="userSpaceOnUse" gradientTransform="translate(10,0)" xmlns:xlink="http://www.w3.org/1999/xlink"/>',
    );
    expect(g).toEqual({
      type: "linear",
      stops: [
        { offset: 0, color: "#1F5FBF" },
        { offset: 1, color: "#9FD0FF00" },
      ],
      start: { x: 10, y: 25 },
      end: { x: 110, y: 25 },
    });
  });
});

it("skips a container paint's <g kalamo:paint> copies instead of reading them as Nodes (ADR-0043)", () => {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 100, height: 100 }],
  });
  createNodes(doc, [
    {
      type: "group",
      parentId: defaultLayerId,
      appearance: { strokes: [{ color: "#FF0000" }], fills: [{ color: "#00FF00" }], contents: 1 },
      children: [{ type: "rect", x: 0, y: 0, width: 10, height: 10 }],
    },
  ]);
  const file = parseSvg(toSvg(doc));
  expect(file.warnings).toEqual([]);
  expect(file.nodes.map((n) => n.type)).toEqual(["layer", "group", "rect"]);
});

describe("container Appearance (ADR-0043)", () => {
  /** A Layer with a Fill above Contents, and in it a Group with a Stroke below Contents. */
  function painted() {
    const { doc, defaultLayerId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 100, height: 100 }],
    });
    doc.nodes.set(defaultLayerId, {
      ...(doc.nodes.get(defaultLayerId) as Node),
      appearance: { fills: [{ type: "solid", color: "#00FF0080" }], strokes: [], contents: 0 },
    } as Node);
    const [group, rect, inner] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        appearance: {
          fills: [{ color: "#0000FF" }],
          strokes: [{ color: "#FF0000", width: 4, dash: [2, 1] }],
          contents: 2,
        },
        children: [
          { type: "rect", x: 0, y: 0, width: 10, height: 10 },
          { type: "group", children: [{ type: "ellipse", x: 20, y: 0, width: 10, height: 10 }] },
          { type: "rect", x: 40, y: 0, width: 10, height: 10 },
        ],
      },
    ]).nodes;
    const hidden = [...doc.nodes.values()].at(-1);
    if (!group || !rect || !inner || !hidden) throw new Error("setup");
    doc.nodes.set(hidden.id, { ...hidden, visible: false });
    return { doc, layerId: defaultLayerId, group, rect, inner };
  }

  it("reads each <g kalamo:paint> of a Layer or Group back as its Fill or Stroke, and Open of an export is the Document", () => {
    const { doc } = painted();
    const file = parseSvg(toSvg(doc));
    expect(file.warnings).toEqual([]);
    const opened = { ...doc, nodes: new Map(file.nodes.map((n) => [n.id, n])) };
    expect(JSON.parse(serializeDocument(opened))).toEqual(JSON.parse(serializeDocument(doc)));
  });

  it.each([
    ["a text child", "text"],
    ["an inner Clipping Mask", "inner"],
    ["a Clipping Mask's own Appearance", "own"],
  ] as const)("reads back %s, and Open of an export is the Document (#106)", (_, kind) => {
    const { doc, defaultLayerId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 100, height: 100 }],
    });
    const appearance = {
      fills: [{ color: "#0000FF" }],
      strokes: [{ color: "#FF0000", width: 4 }],
      contents: 1,
    };
    const [group, text, clipped, clip] = createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        appearance,
        children: [
          {
            type: "text",
            x: 10,
            y: 50,
            content: "Hi",
            ranges: [{ start: 0, end: 1, fill: "#00FF00" }],
          },
          { type: "rect", x: 20, y: 0, width: 10, height: 10 },
          { type: "rect", x: 25, y: 0, width: 10, height: 10 },
        ],
      },
    ]).nodes;
    if (!group || !text || !clipped || !clip) throw new Error("setup");
    if (kind === "text") doc.nodes.delete(clip.id);
    else {
      const mask = makeMask(doc, { clipNodeId: clip.id, contentIds: [clipped.id] }).group;
      if (kind === "own") {
        doc.nodes.set(group.id, { ...group, appearance: undefined } as Node);
        doc.nodes.set(mask.id, {
          ...mask,
          appearance: group.type === "group" && group.appearance,
        } as Node);
      }
    }
    const file = parseSvg(toSvg(doc));
    expect(file.warnings).toEqual([]);
    const opened = { ...doc, nodes: new Map(file.nodes.map((n) => [n.id, n])) };
    // Make Clipping Mask places its Group between keys; Open numbers siblings afresh.
    const ranked = (d: typeof doc) =>
      JSON.parse(
        serializeDocument({
          ...d,
          nodes: new Map(
            [...d.nodes].map(([id, n]) => [
              id,
              { ...n, index: String(childrenOf(d, n.parentId).indexOf(n)) },
            ]),
          ),
        }),
      );
    expect(ranked(opened)).toEqual(ranked(doc));
  });

  it("drops a paint whose group the designer removed, and takes Contents from where the children are", () => {
    const { doc, group } = painted();
    const out = toSvg(doc).replace(
      /<g kalamo:paint="true"[^>]*inkscape:label="Fill" fill="#0000FF">.*?<\/g>/,
      "",
    );
    const back = parseSvg(out).nodes.find((n) => n.id === group.id);
    expect(back && "appearance" in back && back.appearance).toEqual({
      fills: [],
      strokes: [expect.objectContaining({ color: "#FF0000", width: 4, dash: [2, 1] })],
      contents: 1,
    });
  });

  it("ignores the copies inside, so a moved child leaves no stale outline", () => {
    const { doc, rect } = painted();
    const moved = toSvg(doc).replace(
      `<rect x="0" y="0" width="10" height="10" id="z-${rect.id}"`,
      `<rect x="60" y="0" width="10" height="10" id="z-${rect.id}"`,
    );
    const file = parseSvg(moved);
    expect(file.nodes.find((n) => n.id === rect.id)).toMatchObject({ x: 60 });
    // Written again, the copies follow the child.
    const again = toSvg({ ...doc, nodes: new Map(file.nodes.map((n) => [n.id, n])) });
    expect(again).toContain('<path d="M 60 0 L 70 0 L 70 10 L 60 10 Z"/>');
    expect(again).not.toContain('<path d="M 0 0 L 10 0 L 10 10 L 0 10 Z"/>');
  });

  it("counts Contents past what the walk drops, and ignores a paint's unreadable transform", () => {
    const file = parseSvg(
      svg(
        'viewBox="0 0 10 10"',
        '<g><g kalamo:paint="true" fill="red"/><foreignObject/><g kalamo:paint="true" fill="none" stroke="blue" transform="matrix(1,NaN)"/><rect width="5" height="5"/></g>',
      ),
    );
    const group = file.nodes.find((n) => n.type === "group");
    expect(group && "appearance" in group && group.appearance).toMatchObject({
      fills: [{ color: "#FF0000" }],
      strokes: [{ color: "#0000FF", width: 1 }],
      contents: 2,
    });
  });

  it("warns when a Fill group sits above a Stroke group, which the model cannot hold", () => {
    const file = parseSvg(
      svg(
        'viewBox="0 0 10 10"',
        '<g><g kalamo:paint="true" fill="none" stroke="blue"/><rect width="5" height="5"/><g kalamo:paint="true" fill="red"/></g>',
      ),
    );
    const group = file.nodes.find((n) => n.type === "group");
    expect(group && "appearance" in group && group.appearance).toMatchObject({ contents: 1 });
    expect(file.warnings).toEqual([expect.objectContaining({ code: "UNSUPPORTED_ATTRIBUTE" })]);
  });

  it("drops a paint group outside a Layer or Group with a warning", () => {
    const file = parseSvg(
      svg(
        'viewBox="0 0 10 10"',
        '<g kalamo:paint="true" fill="red"><path d="M 0 0 L 5 0 L 5 5 Z"/></g>',
      ),
    );
    expect(file.nodes.map((n) => n.type)).toEqual(["layer"]);
    expect(file.nodes[0]).not.toHaveProperty("appearance");
    expect(file.warnings).toEqual([expect.objectContaining({ code: "UNSUPPORTED_ELEMENT" })]);
  });

  describe("under a transform, a Stroke scales by √|det| as node_transform scales it", () => {
    const PAINT =
      '<g kalamo:paint="true" fill="none" stroke="blue" stroke-width="4" stroke-dasharray="2 1"/>';
    /** The Appearance of each painted container, in document order, and the warnings. */
    const open = (body: string) => {
      const file = parseSvg(svg('viewBox="0 0 100 100"', body));
      const looks = file.nodes.flatMap((n) =>
        (n.type === "group" || n.type === "layer") && n.appearance ? [n.appearance] : [],
      );
      return { looks, warnings: file.warnings.map((w) => w.code) };
    };
    const group = (transform: string, inner = "") =>
      `<g transform="${transform}">${PAINT}<rect width="5" height="5"/>${inner}</g>`;

    it.each([
      ["a rotation", "rotate(30,25,20)", 4, [2, 1]],
      ["a rotation and a scale", "rotate(30) scale(2)", 8, [4, 2]],
      ["a flip", "scale(-1,1)", 4, [2, 1]],
      ["a flip and a scale", "matrix(-2,0,0,2,10,0)", 8, [4, 2]],
      ["a vertical flip and a rotation", "rotate(90) scale(3,-3)", 12, [6, 3]],
    ])("keeps %s exact and silent", (_, transform, width, dash) => {
      const { looks, warnings } = open(group(transform));
      expect(looks).toEqual([
        { fills: [], strokes: [expect.objectContaining({ width, dash })], contents: 1 },
      ]);
      expect(warnings).toEqual([]);
    });

    it("scales a rotated Layer's Stroke the same way", () => {
      const { looks, warnings } = open(
        `<g inkscape:groupmode="layer" transform="rotate(45) scale(0.5)">${PAINT}<rect width="5" height="5"/></g>`,
      );
      expect(looks).toEqual([
        expect.objectContaining({
          strokes: [expect.objectContaining({ width: 2, dash: [1, 0.5] })],
        }),
      ]);
      expect(warnings).toEqual([]);
    });

    it("multiplies the factors of nested Groups and of the paint group's own transform", () => {
      const nested = open(
        `<g transform="rotate(30) scale(2)">${group("rotate(10) scale(1.5)")}</g>`,
      );
      expect(nested.looks[0]?.strokes[0]).toMatchObject({ width: 12 });
      const own = open(
        '<g><g kalamo:paint="true" fill="none" stroke="blue" stroke-width="4" transform="rotate(20) scale(3)"/></g>',
      );
      expect(own.looks[0]?.strokes[0]).toMatchObject({ width: 12 });
      expect([...nested.warnings, ...own.warnings]).toEqual([]);
    });

    it("keeps a skewed or unevenly scaled container's Stroke at one width, with one warning", () => {
      const skewed = open(group("skewX(30)"));
      expect(skewed.looks[0]?.strokes[0]).toMatchObject({ width: 4, dash: [2, 1] });
      expect(skewed.warnings).toEqual(["UNSUPPORTED_ATTRIBUTE"]);
      const uneven = open(group("scale(2,8)") + group("scale(8,2)"));
      expect(uneven.looks.map((l) => l.strokes[0]?.width)).toEqual([16, 16]);
      expect(uneven.warnings).toEqual(["UNSUPPORTED_ATTRIBUTE"]);
    });

    it.each([
      [
        "Inkscape 1.2.2's nested rotations and scales",
        "matrix(0.99585779,0.8356239,-0.8356239,0.99585779,0,0)",
        "matrix(0.46839142,0.52020138,-0.52020138,0.46839142,0,0)",
        3.64,
      ],
      [
        "a rotation off by 1e-7 in one entry",
        "rotate(17)",
        "matrix(0.8660254,0.5,-0.5,0.8660255,0,0)",
        4,
      ],
      [
        "a flip and a rotation rounded unevenly",
        "rotate(40)",
        "matrix(-0.8660254,0.5,0.5,0.8660255,0,0)",
        4,
      ],
      [
        "a rotation and a scale written with 7 digits",
        "rotate(11)",
        "matrix(0.5870694,0.3812473,-0.3812473,0.5870695,0,0)",
        2.8,
      ],
    ])("keeps %s silent, with the Stroke scaled", (_, outer, inner, width) => {
      const { looks, warnings } = open(`<g transform="${outer}">${group(inner)}</g>`);
      const stroke = looks[0]?.strokes[0];
      expect(stroke?.width).toBeCloseTo(width, 3);
      expect(stroke?.dash?.[0]).toBeCloseTo(width / 2, 3);
      expect(stroke?.dash?.[1]).toBeCloseTo(width / 4, 3);
      expect(warnings).toEqual([]);
    });

    it.each([
      ["100% × 100.01%", "scale(1,1.0001)", 4 * Math.sqrt(1.0001)],
      ["a skew of 0.01°", "skewX(0.01)", 4],
      ["100.001% × 100%", "scale(1.00001,1)", 4 * Math.sqrt(1.00001)],
    ])("still warns once about %s, with the Stroke at √|det|", (_, transform, width) => {
      const { looks, warnings } = open(group(transform));
      expect(looks[0]?.strokes[0]?.width).toBeCloseTo(width, 3);
      expect(warnings).toEqual(["UNSUPPORTED_ATTRIBUTE"]);
    });

    it("drops a paint group its own transform flattens, and does not count it in Contents", () => {
      const { looks, warnings } = open(
        `<g><g kalamo:paint="true" fill="red" transform="scale(0,1)"/>${PAINT}<rect width="5" height="5"/></g>`,
      );
      expect(looks).toEqual([
        { fills: [], strokes: [expect.objectContaining({ width: 4 })], contents: 1 },
      ]);
      expect(warnings).toEqual(["INVALID_TRANSFORM"]);
    });

    it("puts the children where the rotation drew them, so the copies follow on the next export", () => {
      const { doc, group, rect } = painted();
      const turned = toSvg(doc).replace(
        `id="z-${group.id}"`,
        `id="z-${group.id}" transform="rotate(90)"`,
      );
      const file = parseSvg(turned);
      expect(file.warnings).toEqual([]);
      expect(file.nodes.find((n) => n.id === rect.id)).toMatchObject({
        transform: [0, 1, -1, 0, 0, 0],
      });
      const again = toSvg({ ...doc, nodes: new Map(file.nodes.map((n) => [n.id, n])) });
      expect(again).toContain('<path d="M 0 0 L 0 10 L -10 10 L -10 0 Z"/>');
      expect(again).not.toContain('<path d="M 0 0 L 10 0 L 10 10 L 0 10 Z"/>');
    });

    it.each([
      [[0, 2, -2, 0, 10, 5]],
      [[-1, 0, 0, 1, 50, 0]],
      [[0, -1, -1, 0, 0, 0]],
      [[-1.5, 0, 0, -1.5, 3, 4]],
    ] as Matrix[][])(
      "Opens a Group transformed by %j as node_transform with scaleStrokes leaves it",
      (m) => {
        const { doc, group } = painted();
        const turned = toSvg(doc).replace(
          `id="z-${group.id}"`,
          `id="z-${group.id}" transform="matrix(${m.join(",")})"`,
        );
        const file = parseSvg(turned);
        expect(file.warnings).toEqual([]);
        transformNodes(doc, {
          nodeIds: [group.id],
          matrix: m,
          pivot: { x: 0, y: 0 },
          scaleStrokes: true,
        });
        const opened = { ...doc, nodes: new Map(file.nodes.map((n) => [n.id, n])) };
        expect(JSON.parse(serializeDocument(opened))).toEqual(JSON.parse(serializeDocument(doc)));
      },
    );
  });

  describe("gradients (#107)", () => {
    const stops = [
      { offset: 0, color: "#000000" },
      { offset: 1, color: "#FFFFFF80" },
    ];
    /** A Group with a linear Fill above Contents and an elliptical radial Stroke below. */
    function gradients() {
      const { doc, defaultLayerId } = createDocument({
        id: "d",
        name: "Doc",
        artboards: [{ width: 100, height: 100 }],
      });
      const [group, , text] = createNodes(doc, [
        {
          type: "group",
          parentId: defaultLayerId,
          appearance: {
            fills: [{ type: "gradient", gradient: { type: "linear", stops, angle: 30 } }],
            strokes: [
              {
                type: "gradient",
                width: 3,
                gradient: {
                  type: "radial",
                  stops,
                  aspectRatio: 0.5,
                  angle: 20,
                  focus: { x: 30, y: 20 },
                },
              },
            ],
            contents: 1,
          },
          children: [
            { type: "rect", x: 0, y: 0, width: 40, height: 20 },
            { type: "text", x: 10, y: 50, content: "Hi" },
          ],
        },
      ]).nodes;
      if (!group || !text) throw new Error("setup");
      // Turned and scaled, so the text copy paints with a gradient of its own.
      doc.nodes.set(text.id, { ...text, transform: [1.2, 0.35, -0.35, 1.2, 0, 0] });
      return { doc, group };
    }
    const saved = (doc: ReturnType<typeof gradients>["doc"], nodes: Node[]) =>
      JSON.parse(serializeDocument({ ...doc, nodes: new Map(nodes.map((n) => [n.id, n])) }));
    const appearanceOf = (nodes: Node[], id: string) => {
      const n = nodes.find((m) => m.id === id);
      return n?.type === "group" ? n.appearance : undefined;
    };

    it("reads a container gradient back unchanged, and Open of an export is the Document", () => {
      const { doc } = gradients();
      const file = parseSvg(toSvg(doc));
      expect(file.warnings).toEqual([]);
      expect(saved(doc, file.nodes)).toEqual(saved(doc, [...doc.nodes.values()]));
    });

    it.each([
      [[0, 2, -2, 0, 10, 5]],
      [[-1, 0, 0, 1, 50, 0]],
      [[1.5, 0, 0, 1.5, 3, 4]],
    ] as Matrix[][])("Opens a Group transformed by %j as node_transform leaves it", (m) => {
      const { doc, group } = gradients();
      const turned = toSvg(doc).replace(
        `id="z-${group.id}"`,
        `id="z-${group.id}" transform="matrix(${m.join(",")})"`,
      );
      const file = parseSvg(turned);
      expect(file.warnings).toEqual([]);
      transformNodes(doc, { nodeIds: [group.id], matrix: m, pivot: { x: 0, y: 0 } });
      expect(appearanceOf(file.nodes, group.id)).toEqual(
        appearanceOf([...doc.nodes.values()], group.id),
      );
    });

    it("maps a Fill under a skew exactly and silently", () => {
      const { doc, group } = gradients();
      doc.nodes.set(group.id, {
        ...group,
        appearance: { ...(group.type === "group" && group.appearance), strokes: [], contents: 0 },
      } as Node);
      const m: Matrix = [1, 0.3, 0.5, 2, 4, 0];
      const skewed = toSvg(doc).replace(
        `id="z-${group.id}"`,
        `id="z-${group.id}" transform="matrix(${m.join(",")})"`,
      );
      const file = parseSvg(skewed);
      expect(file.warnings).toEqual([]);
      transformNodes(doc, { nodeIds: [group.id], matrix: m, pivot: { x: 0, y: 0 } });
      expect(appearanceOf(file.nodes, group.id)).toEqual(
        appearanceOf([...doc.nodes.values()], group.id),
      );
    });

    it("reads Inkscape's split stops and positioned gradient, with a gradientTransform", () => {
      const file = parseSvg(
        svg(
          'viewBox="0 0 100 100"',
          '<defs><linearGradient id="s"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>' +
            '<linearGradient id="p" href="#s" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="10" y2="0" gradientTransform="translate(5,0)"/></defs>' +
            '<g><rect width="20" height="20"/><g kalamo:paint="true" fill="url(#p)"><path d="M 0 0 L 20 0 L 20 20 Z"/></g></g>',
        ),
      );
      expect(file.warnings).toEqual([]);
      const group = file.nodes.find((n) => n.type === "group");
      expect(group && "appearance" in group && group.appearance).toEqual({
        fills: [
          {
            type: "gradient",
            gradient: {
              type: "linear",
              stops: [
                { offset: 0, color: "#FF0000" },
                { offset: 1, color: "#0000FF" },
              ],
              start: { x: 5, y: 0 },
              end: { x: 15, y: 0 },
            },
          },
        ],
        strokes: [],
        contents: 0,
      });
    });

    it("resolves objectBoundingBox against the paint group's box, its copies' transforms included", () => {
      const file = parseSvg(
        svg(
          'viewBox="0 0 100 100"',
          '<defs><radialGradient id="b"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient></defs>' +
            '<g><rect width="20" height="20"/><g kalamo:paint="true" fill="url(#b)">' +
            '<path d="M 10 10 L 30 10 L 30 20 L 10 20 Z"/><g><path d="M 0 0 L 10 0 L 10 10 Z" transform="translate(40,20)"/></g></g></g>',
        ),
      );
      const group = file.nodes.find((n) => n.type === "group");
      // The box is 10,10 to 50,30: 40 by 20, so the circle becomes an ellipse half as tall.
      expect(group && "appearance" in group && group.appearance).toMatchObject({
        fills: [
          {
            gradient: {
              type: "radial",
              center: { x: 30, y: 20 },
              radius: 20,
              aspectRatio: 0.5,
              angle: 0,
              focus: { x: 30, y: 20 },
            },
          },
        ],
      });
    });
  });

  it("reads a generic <g fill> as inherited by its children, with no container Appearance", () => {
    const file = parseSvg(
      svg('viewBox="0 0 10 10"', '<g fill="red"><rect width="5" height="5"/></g>'),
    );
    const [, group, rect] = file.nodes;
    expect(group).toMatchObject({ type: "group" });
    expect(group).not.toHaveProperty("appearance");
    expect(rect).toMatchObject({ appearance: { fills: [{ color: "#FF0000" }] } });
  });
});

it("warns MISSING_GLYPHS once for a file, naming the union of its texts' missing characters", () => {
  const file = parseFile(
    '<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="10">กข</text><text x="0" y="30">ขค ok</text></svg>',
  );
  const texts = file.nodes.filter((n) => n.type === "text");
  expect(file.warnings).toEqual([
    {
      code: "MISSING_GLYPHS",
      nodeId: texts[0]?.id,
      message:
        "None of Source Sans 3, Noto Sans SC, or Noto Sans KR has glyphs for ก, ข, ค; they render as .notdef boxes and measure as the box's width.",
    },
  ]);
});

describe("the former name's namespace, read beside Kalamo's forever (ADR-0069)", () => {
  /** `text` as the former name exported it: its namespace URI and prefix. */
  const legacy = (text: string) =>
    text.replaceAll(DIALECT_NS.kalamo, LEGACY_SVG_NS).replaceAll(/\bkalamo(?=[:=])/g, LEGACY_NAME);
  const AB = "01M38T29S8GTJN2S1004N4Q1BH";
  const SRC = "c".repeat(64);
  const read = (text: string) =>
    resolveLinks(parseFile(text), (id) =>
      id === SRC ? { mime: "image/png" as const, width: 2, height: 3 } : undefined,
    );

  it("imports an export in the former namespace as the same export in Kalamo's", () => {
    const old = legacy(kalamoExport);
    expect(old).not.toMatch(/kalamo[:.=]/);
    expect(parseFile(old)).toEqual(parseFile(kalamoExport));
  });

  it("reads Artboard backgrounds, linked src and the render scope in either namespace", () => {
    const text = svg(
      `width="100" height="50" kalamo:scope="artboard:${AB}"`,
      `<sodipodi:namedview><inkscape:page x="0" y="0" width="100" height="50" id="z-${AB}" inkscape:label="Front"/></sodipodi:namedview>` +
        `<rect width="100" height="50" fill="#FFF4D6" kalamo:artboard="${AB}"/>` +
        '<rect width="100" height="50" fill="#000000" kalamo:background="true"/>' +
        '<g id="z-01J00000000000000000000A01" inkscape:groupmode="layer" inkscape:label="L">' +
        `<image id="z-01J00000000000000000000A02" width="4" height="3" href="a.png" kalamo:src="${SRC}"/></g>`,
    );
    const kalamo = read(text);
    expect(kalamo.artboards[0]?.background).toBe("#FFF4D6");
    expect(kalamo.scope).toEqual({ artboardId: AB });
    expect(kalamo.nodes).toContainEqual(expect.objectContaining({ type: "image", src: SRC }));
    expect(kalamo.nodes.filter((n) => n.type === "rect")).toEqual([]);
    expect(read(legacy(text))).toEqual(kalamo);
  });

  it("takes Kalamo's attribute when an element carries both", () => {
    const file = parseFile(
      svg(
        `xmlns:${LEGACY_NAME}="${LEGACY_SVG_NS}"`,
        `<g inkscape:groupmode="layer"><rect width="1" height="1" kalamo:tags='["new"]' ${LEGACY_NAME}:tags='["old"]'/>` +
          `<rect width="1" height="1" ${LEGACY_NAME}:tags='["old"]'/></g>`,
      ),
    );
    expect(file.nodes.filter((n) => n.type === "rect").map((n) => n.tags)).toEqual([
      ["new"],
      ["old"],
    ]);
  });
});
