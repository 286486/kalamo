import {
  type Appearance,
  type Artboard,
  applyTo,
  childrenOf,
  clippingPath,
  containerAppearance,
  crossedFrame,
  type Document,
  ellipseMatrix,
  type Fill,
  fontFace,
  formatNumber,
  formatPath,
  type Gradient,
  type GroupNode,
  IDENTITY,
  type ImageSource,
  invert,
  type LayerNode,
  type LeafNode,
  layoutText,
  lookup,
  type Matrix,
  MISSING_LINK_STROKE,
  mapGradient,
  type Node,
  paintedLeaves,
  type Rect,
  type RenderScope,
  round,
  type ShapeNode,
  type Stroke,
  scaleOf,
  shapeSegments,
  type TextNode,
  textBox,
  transformSegments,
  union,
  unscaledStroke,
  visibleBounds,
  worldTransform,
  ZibelError,
} from "@zibel/core";
import {
  arcAttrs,
  areaId,
  clipId,
  gradientId,
  paintAttrs,
  SVG_STROKE,
  scopeAttr,
  starAttrs,
  XMLNS,
  xmlId,
  zibel,
} from "./dialect.ts";

// Whitespace as references too: an XML parser turns a raw newline in an attribute into a space.
export const esc = (s: string) => s.replace(/[&<>"\t\n\r]/g, (c) => ESCAPES[c] ?? c);
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "\t": "&#9;",
  "\n": "&#10;",
  "\r": "&#13;",
};

export type Attrs = Record<string, string | number | undefined>;

export const attrs = (a: Attrs) =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join("");

/** The area a doc-scope render covers: every Artboard. */
export function docRect(doc: Document): Rect {
  return union(doc.artboards.map((a) => a.frame)) ?? { x: 0, y: 0, width: 0, height: 0 };
}

/** The rect a Render Scope covers, in document coordinates (ADR-0014). */
export function scopeRect(doc: Document, scope?: RenderScope): Rect {
  if (!scope) return docRect(doc);
  if ("rect" in scope) return scope.rect;
  if ("artboardId" in scope) {
    const artboard = doc.artboards.find((a) => a.id === scope.artboardId);
    if (artboard) return artboard.frame;
    throw new ZibelError({
      code: "ARTBOARD_NOT_FOUND",
      message: `No Artboard with id ${scope.artboardId}.`,
      hint: "zibel_doc_get_info lists the Artboards with their ids.",
      path: "scope.artboardId",
    });
  }
  const rect = union(
    scope.nodeIds.map((id, i) => visibleBounds(doc, lookup(doc, id, `scope.nodeIds[${i}]`))),
  );
  if (rect) return rect;
  throw new ZibelError({
    code: "NOTHING_TO_RENDER",
    message: "The listed Nodes are empty Layers or Groups: there is nothing to draw.",
    hint: "List Nodes that contain artwork, or pass scope {rect} instead.",
    path: "scope.nodeIds",
  });
}

/**
 * The rect an SVG `export` of `scope` covers: the scope's, but at doc scope one Artboard. Inkscape
 * binds the page at (0,0) to the viewBox and resizes it on save, so the viewBox is that Artboard,
 * else the first, and the other Artboards are pages outside it (ADR-0017).
 */
export function svgRect(doc: Document, scope?: RenderScope): Rect {
  if (scope) return scopeRect(doc, scope);
  const origin = doc.artboards.find((a) => a.frame.x === 0 && a.frame.y === 0);
  return (origin ?? doc.artboards[0])?.frame ?? docRect(doc);
}

export interface SvgOptions {
  /** The Render Scope drawn (default: the Document). A nodeIds scope draws only those Nodes and what they contain, and no Artboard backgrounds. */
  scope?: RenderScope;
  /** A colour filling the whole rect beneath everything. */
  background?: string;
  /** Markup after the artwork, given the Nodes drawn but Layers: `render` adds Render Overlays so. */
  trailer?: (drawn: Node[]) => string;
  /** The file of each Image by id; the Document holds only the ids (ADR-0023). */
  images?: ImageSource;
  /**
   * How a linked Image is written (ADR-0042): `link` (default) names its file, as `export` SVG and
   * Download SVG do, for Inkscape; `draw` shows its pixels, or a missing link's crossed frame, as
   * `render` and PNG do.
   */
  linked?: "link" | "draw";
  /** The stroke width in pt of a missing link drawn by `draw`: one pixel at the render's scale. */
  hairline?: number;
  /**
   * Leaves out, with all it contains, every Node whose visible bounds miss this rect or that draws
   * nothing; a Clipping Path is written whenever its Clipping Mask is. `render` passes it, since
   * resvg panics on an isolated Node far outside the image (ADR-0054). Nodes left out are not drawn.
   */
  cull?: Rect;
}

/** Which Nodes a walk draws: all of them, or those inside `scope`. */
interface Walk {
  scope: Set<string> | undefined;
  inside: boolean;
  /** Inside a hidden Node: written, but not drawn. */
  hidden?: boolean;
  /** Collects the Nodes drawn, but Layers, for the trailer. */
  drawn: Node[];
  images: ImageSource | undefined;
  linked: "link" | "draw";
  hairline: number;
  /** The cull rect, and the Nodes it keeps so far, whose copies a container's Appearance paints. */
  cull?: { rect: Rect; kept: Set<string> };
}

/**
 * SVG of `rect` in document coordinates, in Inkscape's dialect (ADR-0017): `render` and `export`
 * both write it. The default rect is what an SVG `export` of the scope covers.
 */
export function toSvg(doc: Document, rect?: Rect, opts: SvgOptions = {}): string {
  const { scope } = opts;
  const { x, y, width, height } = rect ?? svgRect(doc, scope);
  const nodeIds = scope && "nodeIds" in scope ? new Set(scope.nodeIds) : undefined;
  // Inkscape resizes the page at (0,0) to the viewBox, so a file carries only the pages that fit
  // it: every Artboard at doc scope, one at artboard scope, none for a selection or a rect.
  const pages = !scope
    ? doc.artboards
    : "artboardId" in scope
      ? doc.artboards.filter((a) => a.id === scope.artboardId)
      : [];
  const namedview = pages.length
    ? `<sodipodi:namedview inkscape:document-units="pt">${pages
        .map(
          (a) =>
            `<inkscape:page${attrs({ ...num(a.frame), id: xmlId(a.id), "inkscape:label": a.name })}/>`,
        )
        .join("")}</sodipodi:namedview>`
    : `<sodipodi:namedview inkscape:document-units="pt"/>`;
  const background = [
    // Marked, so importing the file does not make it a Node.
    opts.background
      ? `<rect${attrs({ x, y, width, height, ...paintAttrs("fill", opts.background), [zibel("background")]: "true" })}/>`
      : "",
    ...(nodeIds ? [] : doc.artboards)
      .filter((a): a is Artboard & { background: string } => !!a.background)
      .map(
        (a) =>
          `<rect${attrs({ ...num(a.frame), ...paintAttrs("fill", a.background), [zibel("artboard")]: a.id, "sodipodi:insensitive": "true" })}/>`,
      ),
  ].join("");
  const drawn: Node[] = [];
  const body = childrenOf(doc, null)
    .map((n) =>
      node(doc, n, {
        scope: nodeIds,
        inside: !nodeIds,
        drawn,
        images: opts.images,
        linked: opts.linked ?? "link",
        hairline: opts.hairline ?? 1,
        cull: opts.cull && { rect: opts.cull, kept: new Set() },
      }),
    )
    .join("");
  const trailer = opts.trailer?.(drawn) ?? "";
  const root = attrs({
    ...XMLNS,
    width: `${width}pt`,
    height: `${height}pt`,
    viewBox: `${x} ${y} ${width} ${height}`,
    [zibel("scope")]: scopeAttr(scope),
    // Inkscape shows it as the file name, and import reads the Document name back from it.
    "sodipodi:docname": `${doc.name}.svg`,
  });
  return `<svg${root}>${namedview}${background}${body}${trailer}</svg>`;
}

/** A gradient as one self-contained `userSpaceOnUse` element (ADR-0026). */
function gradient(id: string, g: Gradient): string {
  const stops = g.stops.map((s) => {
    const opacity = s.color.length === 9 ? Number.parseInt(s.color.slice(7), 16) / 255 : 1;
    return `<stop${attrs({
      offset: formatNumber(s.offset),
      "stop-color": s.color.slice(0, 7),
      // Inkscape 1.2 draws #RRGGBBAA black (ADR-0017).
      "stop-opacity": opacity === 1 ? undefined : formatNumber(opacity),
    })}/>`;
  });
  const units = { id, gradientUnits: "userSpaceOnUse" };
  if (g.type === "linear") {
    const { start, end } = g;
    const at = num({ x1: start.x, y1: start.y, x2: end.x, y2: end.y });
    return `<linearGradient${attrs({ ...units, ...at })}>${stops.join("")}</linearGradient>`;
  }
  const m = ellipseMatrix(g);
  const { center, focus } = g;
  // The focus is stored where it is drawn, so it goes back through the ellipse, at the matrix's
  // 6 decimals so it reads back to the same point.
  const [fx, fy] = m
    ? applyTo(invert(m), focus.x, focus.y).map((v) => Math.round(v * 1e6) / 1e6 || 0)
    : [formatNumber(focus.x), formatNumber(focus.y)];
  const centred = focus.x === center.x && focus.y === center.y;
  return `<radialGradient${attrs({
    ...units,
    ...num({ cx: center.x, cy: center.y, r: g.radius }),
    ...(!centred && { fx, fy }),
    gradientTransform: m && `matrix(${round(m).join(" ")})`,
  })}>${stops.join("")}</radialGradient>`;
}

const strokeStyle = (s: Stroke): Attrs => ({
  "stroke-width": s.width,
  "stroke-linecap": s.cap === SVG_STROKE.cap ? undefined : s.cap,
  "stroke-linejoin": s.join === SVG_STROKE.join ? undefined : s.join,
  "stroke-miterlimit": s.join === SVG_STROKE.join ? s.miterLimit : undefined,
  "stroke-dasharray": s.dash.length > 0 ? s.dash.join(" ") : undefined,
});

/** Numbers at export precision. */
const num = (a: Record<string, number>) =>
  Object.fromEntries(Object.entries(a).map(([k, v]) => [k, formatNumber(v)]));

/** The element and geometry of a shape, as the Inkscape tool that draws it writes them. */
function shape(n: ShapeNode): string {
  switch (n.type) {
    case "rect": {
      const r = Math.min(n.radius, n.width / 2, n.height / 2);
      const { x, y, width, height } = n;
      return `rect${attrs(num({ x, y, width, height, ...(r > 0 && { rx: r, ry: r }) }))}`;
    }
    case "ellipse": {
      const { arc, cx, cy, rx, ry, start, end, type, open } = arcAttrs(n);
      if (arc) {
        // Inkscape's arc tool rebuilds the outline from these on load, so d is the same outline.
        return `path${attrs({
          "sodipodi:type": "arc",
          "sodipodi:cx": formatNumber(cx),
          "sodipodi:cy": formatNumber(cy),
          "sodipodi:rx": formatNumber(rx),
          "sodipodi:ry": formatNumber(ry),
          "sodipodi:start": start,
          "sodipodi:end": end,
          "sodipodi:arc-type": type,
          "sodipodi:open": open ? "true" : undefined,
          d: formatPath(shapeSegments(n)),
        })}`;
      }
      return rx === ry
        ? `circle${attrs(num({ cx, cy, r: rx }))}`
        : `ellipse${attrs(num({ cx, cy, rx, ry }))}`;
    }
    case "line":
      return `line${attrs(num({ x1: n.x1, y1: n.y1, x2: n.x2, y2: n.y2 }))}`;
    case "polygon":
    case "star": {
      // Inkscape's star tool rebuilds the outline from these on load, so d is the same outline.
      // They are at full precision: a randomized star seeds its jitter from them (ADR-0024).
      const { sides, r1, r2, arg1, arg2, flat, rounded, randomized } = starAttrs(n);
      return `path${attrs({
        "sodipodi:type": "star",
        "sodipodi:sides": sides,
        "sodipodi:cx": n.cx,
        "sodipodi:cy": n.cy,
        "sodipodi:r1": r1,
        "sodipodi:r2": r2,
        "sodipodi:arg1": arg1,
        "sodipodi:arg2": arg2,
        "inkscape:flatsided": String(flat),
        "inkscape:rounded": rounded,
        "inkscape:randomized": randomized,
        d: formatPath(shapeSegments(n)),
      })}`;
    }
    default:
      // The same outline node_get reports as d.
      return `path${attrs({
        d: formatPath(shapeSegments(n)),
        // nonzero is SVG's default, and a Path stored before ADR-0018 has no rule at all.
        "fill-rule": n.fillRule === "evenodd" ? "evenodd" : undefined,
      })}`;
  }
}

/** A Node's transform, at the precision it is stored in so the file opens with the same matrix. */
const transformAttr = (m: Matrix) =>
  m.every((v, i) => v === IDENTITY[i]) ? undefined : `matrix(${round(m).join(" ")})`;

const style = (...parts: (string | false)[]) => parts.filter(Boolean).join(";") || undefined;

/** Whether two rects share more than an edge. */
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function node(doc: Document, n: Node, walk: Walk): string {
  if (walk.cull) {
    const b = visibleBounds(doc, n);
    if (!b || !overlaps(b, walk.cull.rect)) return "";
    walk.cull.kept.add(n.id);
  }
  // A hidden Node is written, so Inkscape shows it in the Layers panel, but never drawn.
  const hidden = walk.hidden || !n.visible;
  const inside = walk.inside || walk.scope?.has(n.id) === true;
  if (inside && !hidden && n.type !== "layer") walk.drawn.push(n);
  const own = {
    id: xmlId(n.id),
    "inkscape:label": n.name || undefined,
    "sodipodi:insensitive": n.locked ? "true" : undefined,
    [zibel("tags")]: n.tags.length > 0 ? JSON.stringify(n.tags) : undefined,
    [zibel("meta")]: Object.keys(n.meta).length > 0 ? JSON.stringify(n.meta) : undefined,
    transform: transformAttr(n.transform),
  };
  const looks = [
    !n.visible && "display:none",
    n.opacity !== 1 && `opacity:${n.opacity}`,
    n.blendMode !== "normal" && `mix-blend-mode:${n.blendMode}`,
  ] as const;
  if (n.type === "layer" || n.type === "group") {
    const clip = clippingPath(doc, n);
    const children = childrenOf(doc, n.id);
    const kids = children.map((c) => (c === clip ? "" : node(doc, c, { ...walk, inside, hidden })));
    // Outside the scope, a container is written only as the way to a listed Node.
    if (!inside && !kids.join("")) return "";
    const layer = n.type === "layer" ? { "inkscape:groupmode": "layer" } : {};
    // A Clipping Mask's clip sits among its children, where Inkscape keeps it (ADR-0021); it is
    // written for every scope that draws the Group, and is never drawn itself.
    if (clip) {
      const leaf = node(doc, clip, { ...walk, inside: true, hidden, drawn: [], cull: undefined });
      // An Area Type's frame cannot sit inside the <clipPath>, so its <defs> goes just before.
      const frame =
        clip.type === "text" && clip.kind === "area" ? `<defs>${areaFrame(clip)}</defs>` : "";
      kids[children.indexOf(clip)] =
        `${frame}<clipPath${attrs({ id: clipId(n.id), clipPathUnits: "userSpaceOnUse" })}>${leaf}</clipPath>`;
    }
    const clipPath = clip ? `url(#${clipId(n.id)})` : undefined;
    const paints = inside ? containerPaints(doc, n, walk.cull?.kept) : [];
    const { contents } = containerAppearance(n);
    const [fills, strokes] =
      clip && inside ? (["fills", "strokes"] as const).map((l) => clipPaint(clip, l)) : ["", ""];
    const below = [...paints.slice(0, contents), fills, ...kids].join("");
    const above = paints.slice(contents).join("");
    const looked = { ...own, ...layer, style: style(...looks) };
    if (!strokes) return `<g${attrs({ ...looked, "clip-path": clipPath })}>${below}${above}</g>`;
    // A Clipping Path's Strokes draw unclipped, so what it clips is wrapped instead (ADR-0051).
    const wrap = (inner: string) =>
      `<g${attrs({ [zibel("clipped")]: "true", "clip-path": clipPath })}>${inner}</g>`;
    return `<g${attrs(looked)}>${wrap(below)}${strokes}${above && wrap(above)}</g>`;
  }
  if (!inside) return "";
  if (n.type === "image") {
    const { x, y, width, height, preserveAspectRatio, src, file } = n;
    const link = file !== undefined && walk.linked === "link";
    if (file !== undefined && src === undefined && walk.linked === "draw") {
      // A missing link's crossed frame, moved into place so the stroke stays a hairline however
      // the Image is scaled.
      const { transform: _, ...rest } = own;
      return `<path${attrs({
        d: formatPath(transformSegments(crossedFrame(n), n.transform)),
        ...rest,
        style: style(
          `fill:none;stroke:${MISSING_LINK_STROKE};stroke-width:${formatNumber(walk.hairline)}`,
          ...looks,
        ),
      })}/>`;
    }
    const href = link ? file : src === undefined ? undefined : walk.images?.(src);
    if (href === undefined) {
      throw new ZibelError({
        code: "INVALID_IMAGE",
        message: `The file of image ${src} was not given to the SVG writer.`,
        hint: "Pass every Image's file through toSvg's images option.",
        path: "src",
      });
    }
    return `<image${attrs({
      ...num({ x, y, width, height }),
      // Always written: Zibel's default, none, is not SVG's.
      preserveAspectRatio,
      "xlink:href": href,
      // So a paste into the same Document finds the pixels it holds (ADR-0042).
      [zibel("src")]: link ? src : undefined,
      ...own,
      style: style(...looks),
    })}/>`;
  }
  // Inside a <clipPath> SVG reads only the geometry and clip-rule (ADR-0051); a text's glyphs clip
  // under nonzero (ADR-0052).
  if (n.type === "text" && n.clipping) return text(n, { ...own, fill: "none" }, []);
  if (n.type !== "text" && n.clipping) {
    const rule = n.type === "path" && n.fillRule === "evenodd" ? "evenodd" : undefined;
    return `<${shape(n)}${attrs({ ...own, fill: "none", "clip-rule": rule })}/>`;
  }
  const { defs, body } = leaf(n, n.appearance, own, looks);
  return `${defs}${body}`;
}

/**
 * A leaf painted with `appearance`, and the `<defs>` of its gradients and Area Type frame, which go
 * before it (ADR-0026). One Fill and one Stroke are one element, so Inkscape selects one object; a
 * longer Appearance is a <g zibel:stack> painting each Fill, then each Stroke: Illustrator's default
 * stacking.
 */
function leaf(
  n: ShapeNode | TextNode,
  { fills, strokes }: Appearance,
  own: Attrs,
  looks: readonly (string | false)[],
  withFrame = true,
): { defs: string; body: string } {
  const element = (a: Attrs, extra: (string | false)[] = []) =>
    n.type === "text"
      ? text(n, a, extra)
      : `<${shape(n)}${attrs({ ...a, style: style(...extra) })}/>`;
  // Each gradient in the <defs> before the element, in list order (ADR-0026).
  const gradients: string[] = [];
  const paint = (list: "fill" | "stroke", p: Fill, i: number): Attrs => {
    if (p.type === "solid") return paintAttrs(list, p.color);
    const id = gradientId(list, i, n.id);
    gradients.push(gradient(id, p.gradient));
    return { [list]: `url(#${id})` };
  };
  const stroke = (s: Stroke, i: number) => ({ ...paint("stroke", s, i), ...strokeStyle(s) });
  let body: string;
  if (fills.length <= 1 && strokes.length <= 1) {
    const [f] = fills;
    const [s] = strokes;
    body = element(
      { ...own, ...(f ? paint("fill", f, 0) : { fill: "none" }), ...(s && stroke(s, 0)) },
      [...looks],
    );
  } else {
    const paints = [
      ...fills.map((f, i) => element(paint("fill", f, i))),
      ...strokes.map((s, i) => element({ fill: "none", ...stroke(s, i) })),
    ].join("");
    body = `<g${attrs({ ...own, [zibel("stack")]: "true", style: style(...looks) })}>${paints}</g>`;
  }
  // Area Type flows in a frame Inkscape keeps in <defs>, one for all its paints (ADR-0022).
  const frame = withFrame && n.type === "text" && n.kind === "area" ? areaFrame(n) : "";
  const defs = frame || gradients.length > 0 ? `<defs>${frame}${gradients.join("")}</defs>` : "";
  return { defs, body };
}

const areaFrame = (n: TextNode) => `<rect${attrs({ id: areaId(n.id), ...num(textBox(n)) })}/>`;

/**
 * A Clipping Path's Fills or its Strokes as a locked `<g zibel:paint>` in its opacity and mode,
 * holding one copy of it without an id painted as a leaf is, in its own transform, with the copy's
 * gradients in a `<defs>` just before the group (ADR-0051); a text's copy flows in the frame its
 * `<clipPath>` wrote. Empty when it has none.
 */
function clipPaint(clip: LeafNode, list: "fills" | "strokes"): string {
  if (clip.appearance[list].length === 0) return "";
  const appearance = { fills: [], strokes: [], [list]: clip.appearance[list] };
  const own = { transform: transformAttr(clip.transform) };
  const { defs, body } = leaf(clip, appearance, own, [], false);
  const fill = list === "fills";
  return `${defs}<g${attrs({
    [zibel("paint")]: fill ? "clip-fill" : "clip-stroke",
    "sodipodi:insensitive": "true",
    "inkscape:label": fill ? "Clipping Path Fill" : "Clipping Path Stroke",
    style: style(
      clip.opacity !== 1 && `opacity:${clip.opacity}`,
      clip.blendMode !== "normal" && `mix-blend-mode:${clip.blendMode}`,
    ),
  })}>${body}</g>`;
}

/**
 * Each Fill, then each Stroke, of a container's Appearance as a locked `<g zibel:paint>` holding a
 * bare copy of every leaf it paints, in document coordinates (ADR-0043): a shape's outline, or a
 * text laid out in its own transform, each in a `<g clip-path>` per inner Clipping Mask it is in.
 * A gradient is in a `<defs>` just before the group: Inkscape 1.2.2 never finishes updating a group
 * holding the `<defs>` it paints from. SVG resolves it in each painting element's user space, so a
 * transformed text copy paints with its own copy of it, mapped back through that transform.
 * Under a cull, only the `kept` leaves get a copy.
 */
function containerPaints(doc: Document, n: LayerNode | GroupNode, kept?: Set<string>): string[] {
  const { fills, strokes } = containerAppearance(n);
  if (fills.length + strokes.length === 0) return [];
  const leaves = paintedLeaves(doc, n).filter((l) => !kept || kept.has(l.node.id));
  const group = (list: "fill" | "stroke", p: Fill | Stroke, i: number) => {
    const stroke = list === "stroke" ? (p as Stroke) : undefined;
    const id = gradientId(list, i, n.id);
    const gradients: string[] = [];
    const copies = leaves.map((l) => {
      let copy: string;
      if (l.node.type === "text") {
        const m = worldTransform(doc, l.node);
        const k = scaleOf(m);
        const moved = m.some((v, i) => v !== IDENTITY[i]);
        let textPaint: string | false = false;
        if (p.type === "gradient" && moved) {
          textPaint = `${list}:url(#${id}-${l.node.id})`;
          gradients.push(gradient(`${id}-${l.node.id}`, mapGradient(p.gradient, invert(m))));
        }
        copy = text(
          l.node,
          {
            transform: moved ? `matrix(${round(m).join(" ")})` : undefined,
            ...(stroke && k !== 1 && strokeStyle(unscaledStroke(stroke, k))),
          },
          [textPaint],
        );
      } else {
        copy = `<path${attrs({ d: formatPath(l.segments), "fill-rule": l.fillRule === "evenodd" ? "evenodd" : undefined })}/>`;
      }
      // Each inner Clipping Mask's own <clipPath>, outermost first.
      return l.clips.reduceRight(
        (inner, c) => `<g${attrs({ "clip-path": `url(#${clipId(c.maskId)})` })}>${inner}</g>`,
        copy,
      );
    });
    let paint: Attrs;
    if (p.type === "solid") paint = paintAttrs(list, p.color);
    else {
      gradients.unshift(gradient(id, p.gradient));
      paint = { [list]: `url(#${id})` };
    }
    const defs = gradients.length > 0 ? `<defs>${gradients.join("")}</defs>` : "";
    return `${defs}<g${attrs({
      [zibel("paint")]: "true",
      "sodipodi:insensitive": "true",
      "inkscape:label": stroke ? "Stroke" : "Fill",
      ...(stroke && { fill: "none" }),
      ...paint,
      ...(stroke && strokeStyle(stroke)),
    })}>${copies.join("")}</g>`;
  };
  return [
    ...fills.map((f, i) => group("fill", f, i)),
    ...strokes.map((k, i) => group("stroke", k, i)),
  ];
}

/**
 * One paint of a text, laid out as `layoutText` draws it (ADR-0022): Point Type as Inkscape's line
 * tspans; Area Type as positioned tspans in its frame, each keeping its trailing spaces and return,
 * then the overflow, hidden, so the file holds every character. Kerned off: resvg honours
 * font-kerning only as a style, and unkerned the drawn width is the advance sum the bounds report
 * (ADR-0013).
 */
function text(n: TextNode, a: Attrs, extra: (string | false)[]): string {
  const { lines, overflow } = layoutText(n);
  const area = n.kind === "area";
  const role = area ? {} : { "sodipodi:role": "line" };
  // A nested tspan for each run of characters with overrides, bare text for the rest (ADR-0029). A range fill
  // goes only where a Fill paints, opaque where the element's fill-opacity would inherit.
  // A container paint's copy has no fill of its own and takes none: its Fill paints every glyph.
  const painted = a.fill !== undefined && a.fill !== "none";
  const spans = (start: number, t: string) => {
    const chars = [...t];
    let out = "";
    let at = 0;
    for (const r of n.ranges ?? []) {
      const from = Math.max(r.start - start, at);
      const to = Math.min(r.end - start, chars.length);
      if (from >= to) continue;
      const span = esc(chars.slice(from, to).join(""));
      const over: Attrs = {
        ...(painted && r.fill && paintAttrs("fill", r.fill)),
        ...(painted &&
          r.fill?.length === 7 &&
          a["fill-opacity"] !== undefined && { "fill-opacity": "1" }),
        "baseline-shift": r.baselineShift && formatNumber(r.baselineShift),
        rotate: r.rotation && formatNumber(r.rotation),
      };
      out += esc(chars.slice(at, from).join(""));
      out += Object.values(over).some(Boolean) ? `<tspan${attrs(over)}>${span}</tspan>` : span;
      at = to;
    }
    return out + esc(chars.slice(at).join(""));
  };
  const tspans = lines.map(
    (l) =>
      `<tspan${attrs({ ...role, ...num({ x: l.x, y: l.y }) })}>${spans(l.start, l.text)}</tspan>`,
  );
  const last = lines.at(-1);
  const hidden = last ? last.start + [...last.text].length : 0;
  if (overflow) {
    tspans.push(`<tspan style="visibility:hidden">${spans(hidden, overflow)}</tspan>`);
  }
  // Auto leading is CSS's unitless 1.2, which also follows the font size.
  const leading = n.leading === undefined ? "1.2" : `${formatNumber(n.leading)}px`;
  // The stored style, which Inkscape and resvg each match to a face as Zibel does (ADR-0028).
  const { weight, italic } = fontFace(n.fontStyle);
  return `<text${attrs({
    ...(!area && num({ x: n.x, y: n.y })),
    "font-family": n.fontFamily,
    "font-size": n.fontSize,
    "font-weight": weight === 400 ? undefined : weight,
    "font-style": italic ? "italic" : undefined,
    "letter-spacing": n.tracking ? formatNumber((n.tracking * n.fontSize) / 1000) : undefined,
    ...a,
    style: style(
      ...extra,
      area && `shape-inside:url(#${areaId(n.id)})`,
      area && "white-space:pre",
      "font-kerning:none",
      `line-height:${leading}`,
    ),
    "xml:space": "preserve",
  })}>${tspans.join("")}</text>`;
}
