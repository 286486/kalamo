import {
  type Appearance,
  type Artboard,
  applyTo,
  type CharacterRange,
  childrenOf,
  clippingPath,
  containerAppearance,
  crossedFrame,
  type Document,
  drawnFamily,
  ellipseMatrix,
  type Fill,
  fontFace,
  fontFamilies,
  formatNumber,
  formatPath,
  type Gradient,
  type GroupNode,
  glyphs,
  grown,
  IDENTITY,
  type ImageSource,
  invert,
  KalamoError,
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
  touches,
  transformSegments,
  union,
  unscaledStroke,
  visibleBounds,
  worldTransform,
} from "@kalamo/core";
import {
  arcAttrs,
  areaId,
  clipId,
  gradientId,
  kalamo,
  paintAttrs,
  SVG_STROKE,
  scopeAttr,
  spiralAttrs,
  starAttrs,
  XMLNS,
  xmlId,
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
    throw new KalamoError({
      code: "ARTBOARD_NOT_FOUND",
      message: `No Artboard with id ${scope.artboardId}.`,
      hint: "kalamo_doc_get_info lists the Artboards with their ids.",
      path: "scope.artboardId",
    });
  }
  const rect = union(
    scope.nodeIds.map((id, i) => visibleBounds(doc, lookup(doc, id, `scope.nodeIds[${i}]`))),
  );
  if (rect) return rect;
  throw new KalamoError({
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
   * Writes the SVG for resvg, which clamps each isolated layer to a fixed band around the image
   * and panics outside it, so `render` passes it (ADR-0054, ADR-0055). A Node whose visible bounds
   * miss the cull rect, or that draws nothing, is left out with all it contains, and is not drawn;
   * a Clipping Path is written whenever its Clipping Mask is. An isolated `<g>` whose content
   * reaches past the bound rect gets a filter that bounds its layer to it.
   */
  resvg?: boolean;
}

/**
 * The margins, in image sides per axis, of the rects `resvg` derives from the rendered rect: the
 * cull rect outside any isolated `<g>` (ADR-0054), and the bound rect and the inner cull rect that
 * keep a nested layer inside its parent layer's band (ADR-0055).
 */
const CULL_MARGIN = 1;
const BOUND_MARGIN = 0.5;
const INNER_CULL_MARGIN = 0.25;

/** The id of the filter that bounds a far-reaching isolated `<g>`: not `z-`, so no Node's (`xmlId`). */
const BOUND_ID = "bound";

const grownBy = (r: Rect, sides: number): Rect => ({
  x: r.x - sides * r.width,
  y: r.y - sides * r.height,
  width: r.width * (1 + 2 * sides),
  height: r.height * (1 + 2 * sides),
});

/** The part of `a` outside `b` is not empty. */
const reaches = (a: Rect, b: Rect) =>
  a.x < b.x || a.y < b.y || a.x + a.width > b.x + b.width || a.y + a.height > b.y + b.height;

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
  /** Inside an isolated `<g>`: a layer of resvg's, so the inner cull rect applies. */
  isolated?: boolean;
  /** Written for resvg: each line of text splits into chunks of one drawing face (ADR-0063). */
  chunked: boolean;
  /**
   * resvg's rects (ADR-0054, ADR-0055), the Nodes kept so far, whose copies a container's
   * Appearance paints, and whether some `<g>` uses the bound filter.
   */
  resvg?: { cull: Rect; inner: Rect; bound: Rect; kept: Set<string>; bounded: boolean };
}

/** The bound filter, for a `<g>` whose layer reaches past the bound rect (ADR-0055); marks it used. */
function boundFilter(resvg: NonNullable<Walk["resvg"]>): string {
  resvg.bounded = true;
  return `url(#${BOUND_ID})`;
}

/** What a container's Appearance paints of a leaf reaches, unclipped: the leaf, grown by its Strokes. */
function copyReach(doc: Document, n: LayerNode | GroupNode) {
  const grow = Math.max(0, ...containerAppearance(n).strokes.map((s) => s.width)) / 2;
  return (leaf: Node) => grown(visibleBounds(doc, leaf), grow);
}

/**
 * What a container's layer holds, as resvg sizes it: its kept children, a Clipping Mask's
 * unclipped, its painted Clipping Path, and its Appearance's copies of kept leaves (ADR-0055).
 */
function layerReach(
  doc: Document,
  n: LayerNode | GroupNode,
  clip: LeafNode | undefined,
  kept: Set<string>,
  { clipPainted, painted }: { clipPainted: boolean; painted: boolean },
): Rect | null {
  const reach = copyReach(doc, n);
  return union([
    ...childrenOf(doc, n.id).map((c) =>
      c !== clip && kept.has(c.id) ? visibleBounds(doc, c) : null,
    ),
    clip && clipPainted ? visibleBounds(doc, clip) : null,
    ...(painted
      ? paintedLeaves(doc, n)
          .filter((l) => kept.has(l.node.id))
          .map((l) => reach(l.node))
      : []),
  ]);
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
      ? `<rect${attrs({ x, y, width, height, ...paintAttrs("fill", opts.background), [kalamo("background")]: "true" })}/>`
      : "",
    ...(nodeIds ? [] : doc.artboards)
      .filter((a): a is Artboard & { background: string } => !!a.background)
      .map(
        (a) =>
          `<rect${attrs({ ...num(a.frame), ...paintAttrs("fill", a.background), [kalamo("artboard")]: a.id, "sodipodi:insensitive": "true" })}/>`,
      ),
  ].join("");
  const drawn: Node[] = [];
  const r = { x, y, width, height };
  const resvg = opts.resvg
    ? {
        cull: grownBy(r, CULL_MARGIN),
        inner: grownBy(r, INNER_CULL_MARGIN),
        bound: grownBy(r, BOUND_MARGIN),
        kept: new Set<string>(),
        bounded: false,
      }
    : undefined;
  const body = childrenOf(doc, null)
    .map((n) =>
      node(doc, n, {
        scope: nodeIds,
        inside: !nodeIds,
        drawn,
        images: opts.images,
        linked: opts.linked ?? "link",
        hairline: opts.hairline ?? 1,
        resvg,
        chunked: !!resvg,
      }),
    )
    .join("");
  // An identity filter: resvg sizes a filtered layer from its region (ADR-0055).
  const filter = resvg && {
    id: BOUND_ID,
    filterUnits: "userSpaceOnUse",
    ...num(resvg.bound),
    "color-interpolation-filters": "sRGB",
  };
  const bound =
    filter && resvg.bounded ? `<defs><filter${attrs(filter)}><feOffset/></filter></defs>` : "";
  const trailer = opts.trailer?.(drawn) ?? "";
  const root = attrs({
    ...XMLNS,
    width: `${width}pt`,
    height: `${height}pt`,
    viewBox: `${x} ${y} ${width} ${height}`,
    [kalamo("scope")]: scopeAttr(scope),
    // Inkscape shows it as the file name, and import reads the Document name back from it.
    "sodipodi:docname": `${doc.name}.svg`,
  });
  return `<svg${root}>${namedview}${background}${bound}${body}${trailer}</svg>`;
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
    case "spiral": {
      // Inkscape's spiral tool rebuilds the outline from these on load, at full precision (ADR-0060).
      const { cx, cy, radius, revolution, expansion, argument, t0 } = spiralAttrs(n);
      return `path${attrs({
        "sodipodi:type": "spiral",
        "sodipodi:cx": cx,
        "sodipodi:cy": cy,
        "sodipodi:radius": radius,
        "sodipodi:revolution": revolution,
        "sodipodi:expansion": expansion,
        "sodipodi:argument": argument,
        "sodipodi:t0": t0,
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

function node(doc: Document, n: Node, walk: Walk): string {
  const { resvg } = walk;
  if (resvg) {
    const b = visibleBounds(doc, n);
    if (!b || !touches(b, walk.isolated ? resvg.inner : resvg.cull)) return "";
    resvg.kept.add(n.id);
  }
  // A hidden Node is written, so Inkscape shows it in the Layers panel, but never drawn.
  const hidden = walk.hidden || !n.visible;
  const inside = walk.inside || walk.scope?.has(n.id) === true;
  if (inside && !hidden && n.type !== "layer") walk.drawn.push(n);
  const own = {
    id: xmlId(n.id),
    "inkscape:label": n.name || undefined,
    "sodipodi:insensitive": n.locked ? "true" : undefined,
    [kalamo("tags")]: n.tags.length > 0 ? JSON.stringify(n.tags) : undefined,
    [kalamo("meta")]: Object.keys(n.meta).length > 0 ? JSON.stringify(n.meta) : undefined,
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
    const composited = n.opacity !== 1 || n.blendMode !== "normal";
    // resvg composes it as a layer (ADR-0055).
    const layered = composited || !!clip;
    const isolated = walk.isolated || layered;
    const kids = children.map((c) =>
      c === clip ? "" : node(doc, c, { ...walk, inside, hidden, isolated }),
    );
    // Outside the scope, a container is written only as the way to a listed Node.
    if (!inside && !kids.join("")) return "";
    const layer = n.type === "layer" ? { "inkscape:groupmode": "layer" } : {};
    // A Clipping Mask's clip sits among its children, where Inkscape keeps it (ADR-0021); it is
    // written for every scope that draws the Group, and is never drawn itself.
    if (clip) {
      const leaf = node(doc, clip, { ...walk, inside: true, hidden, drawn: [], resvg: undefined });
      // An Area Type's frame cannot sit inside the <clipPath>, so its <defs> goes just before.
      const frame =
        clip.type === "text" && clip.kind === "area" ? `<defs>${areaFrame(clip)}</defs>` : "";
      kids[children.indexOf(clip)] =
        `${frame}<clipPath${attrs({ id: clipId(n.id), clipPathUnits: "userSpaceOnUse" })}>${leaf}</clipPath>`;
    }
    const clipPath = clip ? `url(#${clipId(n.id)})` : undefined;
    const paints = inside ? containerPaints(doc, n, resvg, walk.chunked) : [];
    const { contents } = containerAppearance(n);
    const [fills, strokes] =
      clip && inside
        ? (["fills", "strokes"] as const).map((l) => clipPaint(clip, l, walk.chunked))
        : ["", ""];
    const below = [...paints.slice(0, contents), fills, ...kids].join("");
    const above = paints.slice(contents).join("");
    // The bound filter for a layer holding the painted Clipping Path, or only its Fills.
    const filterFor = (clipPainted: boolean) => {
      if (!resvg || !layered) return undefined;
      const painted = paints.length > 0;
      const reach = layerReach(doc, n, clip, resvg.kept, { clipPainted, painted });
      return reach && reaches(reach, resvg.bound) ? boundFilter(resvg) : undefined;
    };
    const looked = { ...own, ...layer, style: style(...looks) };
    if (!strokes) {
      const filter = filterFor(!!fills);
      return `<g${attrs({ ...looked, "clip-path": clipPath, filter })}>${below}${above}</g>`;
    }
    // A Clipping Path's Strokes draw unclipped, so what it clips is wrapped instead (ADR-0051).
    const inner = filterFor(!!fills);
    const wrap = (content: string) =>
      `<g${attrs({ [kalamo("clipped")]: "true", "clip-path": clipPath, filter: inner })}>${content}</g>`;
    const filter = composited ? filterFor(true) : undefined;
    return `<g${attrs({ ...looked, filter })}>${wrap(below)}${strokes}${above && wrap(above)}</g>`;
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
      throw new KalamoError({
        code: "INVALID_IMAGE",
        message: `The file of image ${src} was not given to the SVG writer.`,
        hint: "Pass every Image's file through toSvg's images option.",
        path: "src",
      });
    }
    return `<image${attrs({
      ...num({ x, y, width, height }),
      // Always written: Kalamo's default, none, is not SVG's.
      preserveAspectRatio,
      "xlink:href": href,
      // So a paste into the same Document finds the pixels it holds (ADR-0042).
      [kalamo("src")]: link ? src : undefined,
      ...own,
      style: style(...looks),
    })}/>`;
  }
  // Inside a <clipPath> SVG reads only the geometry and clip-rule (ADR-0051); a text's glyphs clip
  // under nonzero (ADR-0052).
  if (n.type === "text" && n.clipping) return text(n, { ...own, fill: "none" }, [], walk.chunked);
  if (n.type !== "text" && n.clipping) {
    const rule = n.type === "path" && n.fillRule === "evenodd" ? "evenodd" : undefined;
    return `<${shape(n)}${attrs({ ...own, fill: "none", "clip-rule": rule })}/>`;
  }
  const { defs, body } = leaf(n, n.appearance, own, looks, walk.chunked);
  return `${defs}${body}`;
}

/**
 * A leaf painted with `appearance`, and the `<defs>` of its gradients and Area Type frame, which go
 * before it (ADR-0026). One Fill and one Stroke are one element, so Inkscape selects one object; a
 * longer Appearance is a <g kalamo:stack> painting each Fill, then each Stroke: Illustrator's default
 * stacking.
 */
function leaf(
  n: ShapeNode | TextNode,
  { fills, strokes }: Appearance,
  own: Attrs,
  looks: readonly (string | false)[],
  chunked: boolean,
  withFrame = true,
): { defs: string; body: string } {
  const element = (a: Attrs, extra: (string | false)[] = []) =>
    n.type === "text"
      ? text(n, a, extra, chunked)
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
    body = `<g${attrs({ ...own, [kalamo("stack")]: "true", style: style(...looks) })}>${paints}</g>`;
  }
  // Area Type flows in a frame Inkscape keeps in <defs>, one for all its paints (ADR-0022).
  const frame = withFrame && n.type === "text" && n.kind === "area" ? areaFrame(n) : "";
  const defs = frame || gradients.length > 0 ? `<defs>${frame}${gradients.join("")}</defs>` : "";
  return { defs, body };
}

const areaFrame = (n: TextNode) => `<rect${attrs({ id: areaId(n.id), ...num(textBox(n)) })}/>`;

/**
 * A Clipping Path's Fills or its Strokes as a locked `<g kalamo:paint>` in its opacity and mode,
 * holding one copy of it without an id painted as a leaf is, in its own transform, with the copy's
 * gradients in a `<defs>` just before the group (ADR-0051); a text's copy flows in the frame its
 * `<clipPath>` wrote. Empty when it has none.
 */
function clipPaint(clip: LeafNode, list: "fills" | "strokes", chunked: boolean): string {
  if (clip.appearance[list].length === 0) return "";
  const appearance = { fills: [], strokes: [], [list]: clip.appearance[list] };
  const own = { transform: transformAttr(clip.transform) };
  const { defs, body } = leaf(clip, appearance, own, [], chunked, false);
  const fill = list === "fills";
  return `${defs}<g${attrs({
    [kalamo("paint")]: fill ? "clip-fill" : "clip-stroke",
    "sodipodi:insensitive": "true",
    "inkscape:label": fill ? "Clipping Path Fill" : "Clipping Path Stroke",
    style: style(
      clip.opacity !== 1 && `opacity:${clip.opacity}`,
      clip.blendMode !== "normal" && `mix-blend-mode:${clip.blendMode}`,
    ),
  })}>${body}</g>`;
}

/**
 * Each Fill, then each Stroke, of a container's Appearance as a locked `<g kalamo:paint>` holding a
 * bare copy of every leaf it paints, in document coordinates (ADR-0043): a shape's outline, or a
 * text laid out in its own transform, each in a `<g clip-path>` per inner Clipping Mask it is in.
 * A gradient is in a `<defs>` just before the group: Inkscape 1.2.2 never finishes updating a group
 * holding the `<defs>` it paints from. SVG resolves it in each painting element's user space, so a
 * transformed text copy paints with its own copy of it, mapped back through that transform.
 * For resvg, only the kept leaves get a copy, and a `<g clip-path>` around a far-reaching one is
 * bounded (ADR-0055).
 */
function containerPaints(
  doc: Document,
  n: LayerNode | GroupNode,
  resvg: Walk["resvg"],
  chunked: boolean,
): string[] {
  const { fills, strokes } = containerAppearance(n);
  if (fills.length + strokes.length === 0) return [];
  const leaves = paintedLeaves(doc, n).filter((l) => !resvg || resvg.kept.has(l.node.id));
  const reach = copyReach(doc, n);
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
          chunked,
        );
      } else {
        copy = `<path${attrs({ d: formatPath(l.segments), "fill-rule": l.fillRule === "evenodd" ? "evenodd" : undefined })}/>`;
      }
      // Each inner Clipping Mask's own <clipPath>, outermost first.
      const b = l.clips.length > 0 && reach(l.node);
      const filter = resvg && b && reaches(b, resvg.bound) ? boundFilter(resvg) : undefined;
      return l.clips.reduceRight(
        (inner, c) =>
          `<g${attrs({ "clip-path": `url(#${clipId(c.maskId)})`, filter })}>${inner}</g>`,
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
      [kalamo("paint")]: "true",
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
 * (ADR-0013). `chunked`, for resvg, which picks one face for a whole text chunk, starts a chunk at
 * the character's own x wherever the bundled family a character draws in changes, naming a family
 * other than the text's first (ADR-0063); Inkscape and browsers fall back per character themselves.
 * Otherwise a run of spaces after a character another bundled family draws is a tspan of its own,
 * which Pango draws in the text's family as Kalamo does, not in that character's (ADR-0067).
 */
function text(n: TextNode, a: Attrs, extra: (string | false)[], chunked: boolean): string {
  const { lines, overflow } = layoutText(n);
  const area = n.kind === "area";
  const role = area ? {} : { "sodipodi:role": "line" };
  // A nested tspan for each run of characters with overrides, bare text for the rest (ADR-0029). A
  // range fill goes only where a Fill paints, and a range stroke where a Stroke does (ADR-0068),
  // opaque where the element's opacity would inherit. A container paint's copy has no paint of its
  // own and takes none: its paint covers every glyph.
  const ranges = n.ranges ?? [];
  const paint = (list: "fill" | "stroke", color: string | undefined): Attrs => {
    if (!color || a[list] === undefined || a[list] === "none") return {};
    const opaque = color.length === 7 && a[`${list}-opacity`] !== undefined;
    return { ...paintAttrs(list, color), ...(opaque && { [`${list}-opacity`]: "1" }) };
  };
  const overrides = (r: CharacterRange): Attrs => ({
    ...paint("fill", r.fill),
    ...paint("stroke", r.stroke),
    "baseline-shift": r.baselineShift ? formatNumber(r.baselineShift) : undefined,
    rotate: r.rotation ? formatNumber(r.rotation) : undefined,
    // In user units, as on the <text> (ADR-0029, ADR-0068).
    "letter-spacing":
      r.tracking === undefined ? undefined : formatNumber((r.tracking * n.fontSize) / 1000),
  });
  // For resvg, each shown character's origin, so a chunk can start at it.
  const [first] = fontFamilies(n);
  const origins = chunked ? glyphs(n).map((g) => g.x) : [];
  let shown = 0;
  /** The characters of `t` from code point `start`, and whether they are laid out, so may chunk. */
  const spans = (start: number, t: string, laidOut: boolean) => {
    /**
     * Runs of characters, each with the attributes that set it apart, the x a chunk starts at, and
     * whether it is spaces that need a tspan of their own (ADR-0067).
     */
    const runs: { attrs: string; x?: number; text: string; alone: boolean }[] = [];
    let family = first;
    let [index, range] = [start - 1, 0];
    // Not for resvg: the family of the last character on the line that is not a space (ADR-0067).
    let before: string | undefined;
    for (const char of t) {
      index++;
      while ((ranges[range]?.end ?? Infinity) <= index) range++;
      const r = ranges[range];
      const origin = laidOut ? origins[shown++] : undefined;
      const drawn = chunked && laidOut && char !== "\n" ? drawnFamily(n, char) : family;
      const chunk = drawn !== family && origin !== undefined;
      family = drawn;
      let alone = false;
      if (!chunked) {
        const f = drawnFamily(n, char);
        if (char === " " || char === "\u00a0") alone = before !== undefined && f !== before;
        else before = char === "\n" ? undefined : f;
      }
      const own = attrs({
        ...(r && r.start <= index && overrides(r)),
        "font-family": family === first ? undefined : family,
      });
      const last = runs.at(-1);
      if (!chunk && last?.attrs === own && last.alone === alone) last.text += char;
      else runs.push({ attrs: own, x: chunk ? origin : undefined, text: char, alone });
    }
    return runs
      .map(({ attrs: own, x, text, alone }) => {
        const at = x === undefined ? "" : attrs({ x: formatNumber(x) });
        return own || at || alone ? `<tspan${at}${own}>${esc(text)}</tspan>` : esc(text);
      })
      .join("");
  };

  const tspans = lines.map(
    (l) =>
      `<tspan${attrs({ ...role, ...num({ x: l.x, y: l.y }) })}>${spans(l.start, l.text, true)}</tspan>`,
  );
  const last = lines.at(-1);
  const hidden = last ? last.start + [...last.text].length : 0;
  if (overflow) {
    // Its own chunk for resvg, so its characters do not pick the last shown line's face.
    const at = chunked && last ? num({ x: last.x }) : {};
    tspans.push(
      `<tspan${attrs({ ...at, style: "visibility:hidden" })}>${spans(hidden, overflow, false)}</tspan>`,
    );
  }
  // Auto leading is CSS's unitless 1.2, which also follows the font size.
  const leading = n.leading === undefined ? "1.2" : `${formatNumber(n.leading)}px`;
  // The stored style, which Inkscape and resvg each match to a face as Kalamo does (ADR-0028).
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
