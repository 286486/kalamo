import {
  bounds,
  createDocument,
  createNodes,
  glyphs,
  makeMask,
  type Node,
  type ShapeNode,
  shapeSegments,
  visibleBounds,
} from "@zibel/core";
import { describe, expect, it } from "vitest";
import { type Canvas2D, drawDocument, imagePlacement } from "./canvas.ts";

/**
 * A context that logs every call and property write, with save/restore of its state. Each layer
 * logs "layer" when made, then its lines into the same list prefixed by "> " per level, and
 * composites as "L1", "L2", ….
 */
function recorder(log: string[] = [], prefix = "", layers = { count: 0 }) {
  const stack: Record<string, unknown>[] = [];
  let state: Record<string, unknown> = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    canvas: { width: 100, height: 100, toString: () => "[canvas]" },
  };
  const ctx = new Proxy(
    {},
    {
      get: (_, k: string) =>
        k in state
          ? state[k]
          : (...args: unknown[]) => {
              if (k === "save") stack.push({ ...state });
              if (k === "restore") state = stack.pop() ?? state;
              log.push(prefix + [k, ...args].join(" "));
              if (k === "getTransform") return { a: 2, b: 0, c: 0, d: 2, e: 3, f: 4 };
              if (k.startsWith("create")) {
                return {
                  addColorStop: (...stop: unknown[]) =>
                    log.push(prefix + ["addColorStop", ...stop].join(" ")),
                  toString: () => "[gradient]",
                };
              }
            },
      set: (_, k: string, v) => {
        state[k] = v;
        log.push(`${prefix}${k}=${v}`);
        return true;
      },
    },
  ) as Canvas2D;
  const layer = () => {
    log.push("layer");
    return { ctx: recorder(log, `${prefix}> `, layers).ctx, image: `L${++layers.count}` };
  };
  return { ctx, log, layer };
}

const PATH_OPS = /^(moveTo|lineTo|bezierCurveTo|quadraticCurveTo|closePath)/;
const OP = { M: "moveTo", L: "lineTo", C: "bezierCurveTo", Q: "quadraticCurveTo", Z: "closePath" };
const traced = (n: ShapeNode) => shapeSegments(n).map((s) => [OP[s.cmd], ...s.args].join(" "));

const newDoc = () =>
  createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
  });

it("fills the Artboard background, then traces a rect once and paints its Fill below its Stroke", () => {
  const { doc, defaultLayerId } = newDoc();
  createNodes(doc, [
    {
      type: "rect",
      parentId: defaultLayerId,
      x: 10,
      y: 10,
      width: 50,
      height: 30,
      appearance: { fills: [{ color: "#FF0000" }], strokes: [{ color: "#000000", width: 2 }] },
    },
  ]);
  const { ctx, log, layer } = recorder();
  drawDocument(ctx, doc, layer);
  const body = log.filter((l) => !/^(save|restore|globalAlpha|transform)/.test(l));
  expect(body).toEqual([
    "fillStyle=#FFFFFF",
    "fillRect 0 0 200 100",
    "beginPath",
    "moveTo 10 10",
    "lineTo 60 10",
    "lineTo 60 40",
    "lineTo 10 40",
    "closePath",
    "fillStyle=#FF0000",
    "fill",
    "strokeStyle=#000000",
    "lineWidth=2",
    "lineCap=butt",
    "lineJoin=miter",
    "miterLimit=10",
    "setLineDash ",
    "stroke",
  ]);
});

it("traces every node type with the segments node_get reports, in stacking order", () => {
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
    { type: "polygon", parentId, cx: 50, cy: 50, radius: 10, sides: 5 },
    { type: "star", parentId, cx: 80, cy: 50, outerRadius: 10, innerRadius: 4, points: 5 },
    { type: "path", parentId, d: "M 0 0 Q 10 20 20 0 Z" },
    { type: "layer" },
  ]);
  const leaves = nodes.filter((n): n is ShapeNode => "appearance" in n);
  expect(leaves).toHaveLength(6);
  const { ctx, log, layer } = recorder();
  drawDocument(ctx, doc, layer);
  expect(log.filter((l) => PATH_OPS.test(l))).toEqual(leaves.flatMap(traced));
});

it("skips hidden Nodes, and applies transform through save and restore", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const [hidden, turned] = createNodes(doc, [
    { type: "rect", parentId, x: 0, y: 0, width: 1, height: 1 },
    { type: "rect", parentId, x: 0, y: 0, width: 1, height: 1 },
  ]).nodes as [ShapeNode, ShapeNode];
  hidden.visible = false;
  turned.transform = [0, 1, -1, 0, 60, -10];
  const { ctx, log, layer } = recorder();
  drawDocument(ctx, doc, layer);
  expect(log.filter((l) => l === "beginPath")).toHaveLength(1);
  expect(log).toContain("transform 0 1 -1 0 60 -10");
  expect(ctx.globalAlpha).toBe(1);
});

describe("opacity and blend modes (ADR-0044)", () => {
  const red = { fills: [{ color: "#FF0000" }], strokes: [] };
  const rect = { type: "rect", x: 0, y: 0, width: 1, height: 1, appearance: red } as const;
  const drawn = (nodes: object[], style: Partial<Node>[]) => {
    const { doc, defaultLayerId: parentId } = newDoc();
    doc.images.set("a".repeat(64), { mime: "image/png", width: 1, height: 1 });
    const made = createNodes(doc, nodes.map((n) => ({ parentId, ...n })) as never).nodes;
    for (const [i, s] of style.entries()) Object.assign(made[i] as Node, s);
    const { ctx, log, layer } = recorder();
    drawDocument(ctx, doc, layer, () => ({ image: "IMG", width: 1, height: 1 }));
    return { log, ctx };
  };

  it("draws a single-paint leaf and an Image straight onto the canvas, in their opacity and mode", () => {
    const src = "a".repeat(64);
    const { log, ctx } = drawn(
      [
        rect,
        { ...rect, appearance: { fills: [], strokes: [{ color: "#000000" }] } },
        { type: "image", src, x: 0, y: 0, width: 1, height: 1 },
      ],
      [{ opacity: 0.5 }, { blendMode: "multiply" }, { opacity: 0.25, blendMode: "screen" }],
    );
    expect(log.filter((l) => l.startsWith("layer"))).toEqual([]);
    expect(log.filter((l) => /^global/.test(l))).toEqual([
      "globalAlpha=1",
      "globalAlpha=0.5",
      "globalAlpha=1",
      "globalCompositeOperation=multiply",
      "globalAlpha=0.25",
      "globalCompositeOperation=screen",
    ]);
    expect([ctx.globalAlpha, ctx.globalCompositeOperation]).toEqual([1, "source-over"]);
  });

  it("draws an isolated Group into one layer at full opacity, then composites it once under the identity", () => {
    const group = { type: "group", children: [rect, rect] };
    const { log, ctx } = drawn([group], [{ opacity: 0.5, blendMode: "multiply" }]);
    const layered = log.slice(log.indexOf("layer"));
    expect(layered.filter((l) => l.startsWith("layer"))).toEqual(["layer"]);
    // The layer starts in the target's transform; its children paint in source-over, fully opaque.
    expect(layered.slice(1, 3)).toEqual(["getTransform", "> setTransform 2 0 0 2 3 4"]);
    expect(layered.filter((l) => l.startsWith("> ") && /global/.test(l))).toEqual([
      "> globalAlpha=1",
      "> globalAlpha=1",
    ]);
    expect(layered.filter((l) => !/^(> |layer|getTransform)/.test(l))).toEqual([
      "save",
      "setTransform 1 0 0 1 0 0",
      "globalAlpha=0.5",
      "globalCompositeOperation=multiply",
      "drawImage L1 0 0",
      "restore",
      "restore",
    ]);
    expect([ctx.globalAlpha, ctx.globalCompositeOperation]).toEqual([1, "source-over"]);
  });

  it("gives each nested isolated container its own layer, inside its parent's, and a plain Group none", () => {
    const inner = { type: "group" as const, children: [rect, rect] };
    const layers = (innerStyle: Partial<Node>) => {
      const { doc, defaultLayerId: parentId } = newDoc();
      const [outer, plain] = createNodes(doc, [{ parentId, type: "group", children: [inner] }])
        .nodes as [Node, Node];
      Object.assign(outer, { opacity: 0.5 });
      Object.assign(plain, innerStyle);
      const { ctx, log, layer } = recorder();
      drawDocument(ctx, doc, layer);
      return log.filter((l) => /^(> )*(layer|drawImage)/.test(l));
    };
    expect(layers({})).toEqual(["layer", "drawImage L1 0 0"]);
    expect(layers({ blendMode: "screen" })).toEqual([
      "layer",
      "layer",
      "> drawImage L2 0 0",
      "drawImage L1 0 0",
    ]);
  });

  it("draws a translucent leaf that paints more than once, and any translucent text, in a layer", () => {
    const { log } = drawn(
      [
        { ...rect, appearance: { fills: [{ color: "#FF0000" }], strokes: [{ color: "#000000" }] } },
        {
          ...rect,
          appearance: { fills: [{ color: "#FF0000" }, { color: "#00FF00" }], strokes: [] },
        },
        { type: "text", x: 0, y: 10, content: "Hi" },
      ],
      [{ opacity: 0.5 }, { opacity: 0.5 }, { blendMode: "multiply" }],
    );
    expect(log.filter((l) => /^(layer|drawImage)/.test(l))).toEqual([
      "layer",
      "drawImage L1 0 0",
      "layer",
      "drawImage L2 0 0",
      "layer",
      "drawImage L3 0 0",
    ]);
  });

  it("asks no layer for a hidden isolated Group", () => {
    const { log } = drawn(
      [{ type: "group", children: [rect, rect] }],
      [{ opacity: 0.5, visible: false }],
    );
    expect(log.filter((l) => /^(layer|beginPath)/.test(l))).toEqual([]);
  });
});

describe("container Appearance (ADR-0043)", () => {
  const rect = (x: number, fill?: string) => ({
    type: "rect",
    x,
    y: 0,
    width: 10,
    height: 10,
    appearance: { fills: fill ? [{ color: fill }] : [], strokes: [] },
  });
  const group = (
    appearance: { fills?: string[]; strokes?: string[]; contents?: number },
    children: object[],
  ) => ({
    type: "group",
    appearance: {
      fills: (appearance.fills ?? []).map((color) => ({ color })),
      strokes: (appearance.strokes ?? []).map((color) => ({ color, width: 4 })),
      contents: appearance.contents ?? 0,
    },
    children,
  });
  /** `style` is by Node name. */
  const drawn = (nodes: object[], style: Record<string, Partial<Node>> = {}) => {
    const { doc, defaultLayerId: parentId } = newDoc();
    doc.images.set("a".repeat(64), { mime: "image/png", width: 1, height: 1 });
    createNodes(doc, nodes.map((n) => ({ parentId, ...n })) as never);
    for (const n of doc.nodes.values()) Object.assign(n, style[n.name ?? ""]);
    const { ctx, log, layer } = recorder();
    drawDocument(ctx, doc, layer, () => ({ image: "IMG", width: 1, height: 1 }));
    // Without the Artboard background's two lines.
    return log;
  };
  /** Each fill or stroke as its style and the x its outline starts at, "#CCCCCC@0". */
  const paints = (log: string[]) => {
    let style = "";
    let at = "";
    const out: string[] = [];
    for (const l of log) {
      const m = /^(?:> )*(?:(?:fill|stroke)Style=(\S+)|moveTo (\S+)|(fill|stroke)\b)/.exec(l);
      if (m?.[1]) style = m[1];
      else if (m?.[2]) at = m[2];
      else if (m?.[3]) out.push(`${style}@${at}`);
    }
    return out;
  };

  it("draws each paint over every leaf before the next, the first `contents` below the children", () => {
    const children = [rect(0, "#AAAAAA"), rect(20, "#BBBBBB")];
    const at = (contents: number) =>
      paints(drawn([group({ fills: ["#CCCCCC"], strokes: ["#DDDDDD"], contents }, children)]));
    expect(at(0)).toEqual([
      "#AAAAAA@0",
      "#BBBBBB@20",
      "#CCCCCC@0",
      "#CCCCCC@20",
      "#DDDDDD@0",
      "#DDDDDD@20",
    ]);
    expect(at(1)).toEqual([
      "#CCCCCC@0",
      "#CCCCCC@20",
      "#AAAAAA@0",
      "#BBBBBB@20",
      "#DDDDDD@0",
      "#DDDDDD@20",
    ]);
    expect(at(2)).toEqual([
      "#CCCCCC@0",
      "#CCCCCC@20",
      "#DDDDDD@0",
      "#DDDDDD@20",
      "#AAAAAA@0",
      "#BBBBBB@20",
    ]);
  });

  it("paints a nested Group's leaves with the outer Appearance, over the inner Group's own", () => {
    const inner = group({ strokes: ["#EEEEEE"] }, [rect(20, "#BBBBBB")]);
    const log = drawn([group({ strokes: ["#111111"] }, [rect(0, "#AAAAAA"), inner])]);
    expect(paints(log)).toEqual([
      "#AAAAAA@0",
      "#BBBBBB@20",
      "#EEEEEE@20",
      "#111111@0",
      "#111111@20",
    ]);
  });

  it("paints no hidden child, no Image, and nothing of a hidden Group", () => {
    const image = { type: "image", src: "a".repeat(64), x: 40, y: 0, width: 1, height: 1 };
    const children = [rect(0), { ...rect(20), name: "h" }, image];
    const g = { ...group({ strokes: ["#DDDDDD"] }, children), name: "g" };
    const hide = { visible: false };
    expect(paints(drawn([g], { h: hide }))).toEqual(["#DDDDDD@0"]);
    const hidden = drawn([g], { h: hide, g: hide });
    expect(paints(hidden)).toEqual([]);
  });

  it("fills an evenodd Path with evenodd and a Live Shape with nonzero", () => {
    const path = {
      type: "path",
      d: "M 0 0 L 30 0 L 30 30 Z",
      fillRule: "evenodd",
      appearance: { fills: [], strokes: [] },
    };
    const log = drawn([group({ fills: ["#CCCCCC"] }, [path, rect(40)])]);
    expect(log.filter((l) => /^fill( |$)/.test(l))).toEqual(["fill evenodd", "fill nonzero"]);
  });

  it("sets a Stroke's width, cap, join, miter limit and dash", () => {
    const g = group({}, [rect(0)]) as ReturnType<typeof group>;
    const stroke = {
      color: "#DDDDDD",
      width: 3,
      cap: "round",
      join: "bevel",
      miterLimit: 4,
      dash: [2, 1],
    };
    g.appearance.strokes = [stroke] as never;
    const log = drawn([g]);
    const from = log.indexOf("strokeStyle=#DDDDDD");
    expect(log.slice(from, from + 6)).toEqual([
      "strokeStyle=#DDDDDD",
      "lineWidth=3",
      "lineCap=round",
      "lineJoin=bevel",
      "miterLimit=4",
      "setLineDash 2,1",
    ]);
  });

  it("paints a text child's glyphs in the container's colour, not its range fills, at its scale", () => {
    const text = {
      type: "text",
      name: "t",
      x: 10,
      y: 50,
      content: "Hi",
      ranges: [{ start: 0, end: 1, fill: "#00FF00" }],
      appearance: { fills: [{ color: "#AAAAAA" }], strokes: [] },
    };
    const log = drawn([group({ fills: ["#CCCCCC"], strokes: ["#DDDDDD"] }, [text])], {
      t: { transform: [2, 0, 0, 2, 0, 0] },
    });
    const from = log.indexOf("fillStyle=#CCCCCC");
    expect(log.slice(from).filter((l) => !/^(save|restore)$/.test(l))).toEqual([
      "fillStyle=#CCCCCC",
      "transform 2 0 0 2 0 0",
      'font=12px "Source Sans 3", "Noto Sans SC", "Noto Sans KR"',
      "fontKerning=none",
      "fillText H 10 50",
      expect.stringMatching(/^fillText i /),
      "strokeStyle=#DDDDDD",
      "lineWidth=4",
      "lineCap=butt",
      "lineJoin=miter",
      "miterLimit=10",
      "setLineDash ",
      "transform 2 0 0 2 0 0",
      'font=12px "Source Sans 3", "Noto Sans SC", "Noto Sans KR"',
      "fontKerning=none",
      "strokeStyle=#DDDDDD",
      "lineWidth=2",
      "lineCap=butt",
      "lineJoin=miter",
      "miterLimit=10",
      "setLineDash ",
      expect.stringMatching(/^strokeText H /),
      expect.stringMatching(/^strokeText i /),
    ]);
  });

  /** A Group with a Stroke over a rect and a Clipping Mask of a rect clipped by a rect at x 25. */
  const masked = (outer: "rect" | "mask") => {
    const { doc, defaultLayerId: parentId } = newDoc();
    const [g, , clipped, clip] = createNodes(doc, [
      {
        ...group({ strokes: ["#DDDDDD"] }, [rect(0), rect(20), { ...rect(25), name: "clip" }]),
        parentId,
      } as never,
    ]).nodes as Node[];
    if (!g || !clipped || !clip) throw new Error("setup");
    const mask = makeMask(doc, { clipNodeId: clip.id, contentIds: [clipped.id] }).group;
    if (outer === "mask") {
      Object.assign(mask, { appearance: g.type === "group" && g.appearance });
      Object.assign(g, { appearance: undefined });
    }
    const { ctx, log, layer } = recorder();
    drawDocument(ctx, doc, layer);
    return log;
  };

  it("paints a leaf of an inner Clipping Mask inside that mask's clip, and only that leaf", () => {
    const log = masked("rect");
    const from = log.lastIndexOf("save", log.indexOf("strokeStyle=#DDDDDD"));
    const ops = log.slice(from).filter((l) => /^(save|restore|clip|moveTo|stroke$)/.test(l));
    expect(ops).toEqual([
      "save",
      "moveTo 0 0",
      "stroke",
      "restore",
      "save",
      "moveTo 25 0",
      "clip nonzero",
      "moveTo 20 0",
      "stroke",
      "restore",
      // The Group's and the Layer's own entries.
      "restore",
      "restore",
    ]);
  });

  it("clips a Clipping Mask's own Appearance by its Clipping Path", () => {
    const log = masked("mask");
    const clipAt = log.indexOf("clip nonzero");
    const strokeAt = log.indexOf("strokeStyle=#DDDDDD");
    expect(clipAt).toBeGreaterThan(-1);
    expect(log.slice(clipAt - 5, clipAt)).toContain("moveTo 25 0");
    // Drawn after the clip in the same save, painting the clipped leaf with no inner clip of its own.
    expect(strokeAt).toBeGreaterThan(clipAt);
    expect(log.slice(strokeAt).filter((l) => /^(clip|moveTo|stroke$)/.test(l))).toEqual([
      "moveTo 20 0",
      "stroke",
    ]);
  });

  it("paints a translucent Group's Appearance inside its layer", () => {
    const log = drawn([{ ...group({ strokes: ["#DDDDDD"] }, [rect(0, "#AAAAAA")]), name: "g" }], {
      g: { opacity: 0.5 },
    });
    const inLayer = log.filter((l) => /strokeStyle=#DDDDDD|^(> )*stroke$/.test(l));
    expect(inLayer).toEqual(["> strokeStyle=#DDDDDD", "> stroke"]);
  });
});

it("draws Point Type with fillText per Fill and strokeText per Stroke, unkerned", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  createNodes(doc, [
    {
      type: "text",
      parentId,
      x: 10,
      y: 50,
      content: "Hi",
      appearance: { fills: [{ color: "#FF0000" }], strokes: [{ color: "#0000FF", width: 2 }] },
    },
  ]);
  const { ctx, log, layer } = recorder();
  drawDocument(ctx, doc, layer);
  const body = log.filter((l) => !/^(save|restore|globalAlpha|transform)/.test(l));
  expect(body).toEqual([
    "fillStyle=#FFFFFF",
    "fillRect 0 0 200 100",
    'font=12px "Source Sans 3", "Noto Sans SC", "Noto Sans KR"',
    "fontKerning=none",
    "fillStyle=#FF0000",
    "fillText Hi 10 50",
    "strokeStyle=#0000FF",
    "lineWidth=2",
    "lineCap=butt",
    "lineJoin=miter",
    "miterLimit=10",
    "setLineDash ",
    "strokeText Hi 10 50",
  ]);
});

it("draws a tracked text per character, a turned one about its origin in its range's fill (ADR-0029)", () => {
  const draw = (strokes: object[]) => {
    const { doc, defaultLayerId: parentId } = newDoc();
    createNodes(doc, [
      {
        type: "text",
        parentId,
        x: 10,
        y: 50,
        content: "Hi",
        tracking: 100,
        ranges: [{ start: 1, end: 2, fill: "#FF0000", rotation: 90 }],
        appearance: { fills: [{ color: "#000000" }], strokes } as never,
      },
    ]);
    const { ctx, log, layer } = recorder();
    drawDocument(ctx, doc, layer);
    return log
      .slice(log.findIndex((l) => l.startsWith("font=")))
      .filter((l) => !/^(save|restore)/.test(l));
  };
  const numbers = (l = "") => l.split(" ").slice(1).map(Number);
  const filled = draw([]);
  expect(filled.filter((l) => !l.startsWith("transform"))).toEqual([
    'font=12px "Source Sans 3", "Noto Sans SC", "Noto Sans KR"',
    "fontKerning=none",
    "fillStyle=#000000",
    "fillText H 10 50",
    "fillStyle=#FF0000",
    "fillText i 19.024 50",
  ]);
  const turn = filled.findIndex((l) => l.startsWith("transform"));
  expect(turn).toBe(filled.indexOf("fillText i 19.024 50") - 1);
  expect(numbers(filled[turn])).toEqual(
    [0, 1, -1, 0, 69.024, 30.976].map((v) => expect.closeTo(v, 9)),
  );
  const stroked = draw([{ color: "#0000FF", width: 1 }]);
  const texts = stroked.filter((l) => /^strokeText/.test(l));
  expect(texts).toEqual(["strokeText H 10 50", "strokeText i 19.024 50"]);
  expect(stroked.slice(stroked.indexOf("strokeStyle=#0000FF"))).not.toContain("fillStyle=#FF0000");
});

it("draws each line of Point Type, one leading apart", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  createNodes(doc, [
    {
      type: "text",
      parentId,
      x: 10,
      y: 50,
      content: "Hi\nHo",
      appearance: { fills: [{ color: "#FF0000" }], strokes: [{ color: "#0000FF", width: 2 }] },
    },
  ]);
  const { ctx, log, layer } = recorder();
  drawDocument(ctx, doc, layer);
  expect(log.filter((l) => /^(fill|stroke)Text/.test(l))).toEqual([
    "fillText Hi 10 50",
    "fillText Ho 10 64.4",
    "strokeText Hi 10 50",
    "strokeText Ho 10 64.4",
  ]);
});

it("draws only the lines of Area Type that fit its frame", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  createNodes(doc, [
    {
      type: "text",
      kind: "area",
      parentId,
      x: 10,
      y: 20,
      width: 100,
      height: 40,
      content: "one\ntwo\nthree\nfour",
    },
  ]);
  const { ctx, log, layer } = recorder();
  drawDocument(ctx, doc, layer);
  const drawn = log.filter((l) => l.startsWith("fillText")).map((l) => l.split(" "));
  expect(drawn.map(([, text, x]) => [text, x])).toEqual([
    ["one\n", "10"],
    ["two\n", "10"],
  ]);
  expect(drawn.map(([, , , y]) => Number(y) - 20)).toEqual([
    expect.closeTo(10.249774, 5),
    expect.closeTo(24.649774, 5),
  ]);
});

it("draws a font Zibel does not bundle in Source Sans 3, as render does", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  createNodes(doc, [
    { type: "text", parentId, x: 10, y: 50, content: "Hi", fontFamily: "Helvetica" },
  ]);
  const { ctx, log, layer } = recorder();
  drawDocument(ctx, doc, layer);
  expect(log).toContain('font=12px "Source Sans 3", "Noto Sans SC", "Noto Sans KR"');
});

it("draws a text in Noto Sans SC in it first, then in Source Sans 3 (ADR-0063)", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  createNodes(doc, [
    { type: "text", parentId, x: 10, y: 50, content: "Hi", fontFamily: "Noto Sans SC" },
  ]);
  const { ctx, log, layer } = recorder();
  drawDocument(ctx, doc, layer);
  expect(log).toContain('font=12px "Noto Sans SC", "Source Sans 3", "Noto Sans KR"');
});

it("draws a style in the bundled face it is measured in (ADR-0028)", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  createNodes(doc, [
    { type: "text", parentId, x: 10, y: 50, content: "Hi", fontStyle: "Semibold Italic" },
    { type: "text", parentId, x: 10, y: 80, content: "Hi", fontStyle: "Black" },
  ]);
  const { ctx, log, layer } = recorder();
  drawDocument(ctx, doc, layer);
  expect(log.filter((l) => l.startsWith("font="))).toEqual([
    'font=italic 700 12px "Source Sans 3", "Noto Sans SC", "Noto Sans KR"',
    'font=900 12px "Source Sans 3", "Noto Sans SC", "Noto Sans KR"',
  ]);
});

it("fills a Path with its fill rule", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const d = "M 0 0 L 30 0 L 30 30 Z M 10 5 L 20 5 L 20 15 Z";
  createNodes(doc, [
    {
      type: "path",
      parentId,
      d,
      fillRule: "evenodd",
      appearance: { fills: [{ color: "#000000" }] },
    },
    { type: "path", parentId, d, appearance: { fills: [{ color: "#000000" }] } },
  ]);
  const { ctx, log, layer } = recorder();
  drawDocument(ctx, doc, layer);
  expect(log.filter((l) => l.startsWith("fill ") || l === "fill")).toEqual([
    "fill evenodd",
    "fill",
  ]);
});

it("clips a Clipping Mask's children by its Clipping Path, in document coordinates, and paints nothing of it unpainted", () => {
  const { doc, defaultLayerId: parentId } = newDoc();
  const [content, clip] = createNodes(doc, [
    {
      type: "rect",
      parentId,
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      appearance: { fills: [{ color: "#FF0000" }] },
    },
    { type: "path", parentId, d: "M 0 0 L 10 0 L 10 10 Z", fillRule: "evenodd" },
  ]).nodes as [ShapeNode, ShapeNode];
  makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
  doc.nodes.set(clip.id, {
    ...(doc.nodes.get(clip.id) as ShapeNode),
    transform: [1, 0, 0, 1, 5, 0],
  });
  const { ctx, log, layer } = recorder();
  drawDocument(ctx, doc, layer);
  const body = log.filter(
    (l) => !/^(save|restore|globalAlpha|transform|fillStyle=#FFFFFF|fillRect)/.test(l),
  );
  expect(body).toEqual([
    "beginPath",
    "moveTo 5 0",
    "lineTo 15 0",
    "lineTo 15 10",
    "closePath",
    "clip evenodd",
    "beginPath",
    ...traced(content),
    "fillStyle=#FF0000",
    "fill",
  ]);
});

describe("a Layer Clipping Mask (ADR-0053)", () => {
  /** The default Layer: a red rect in a sublayer, then a blue-stroked `top`, made its Clipping Path. */
  const clippedLayer = (top: object) => {
    const { doc, defaultLayerId: parentId } = newDoc();
    const [sub, clip] = createNodes(doc, [
      { type: "layer", parentId },
      { ...top, parentId } as never,
    ]).nodes as [Node, Node];
    createNodes(doc, [
      {
        type: "rect",
        parentId: sub.id,
        x: 0,
        y: 0,
        width: 50,
        height: 50,
        appearance: { fills: [{ color: "#FF0000" }] },
      },
    ]);
    makeMask(doc, { layerId: parentId });
    Object.assign(doc.nodes.get(clip.id) as Node, {
      appearance: { fills: [], strokes: [{ ...STROKE, color: "#0000FF" }] },
    });
    const { ctx, log, layer } = recorder();
    drawDocument(ctx, doc, layer);
    return log;
  };
  const STROKE = {
    type: "solid",
    width: 2,
    cap: "butt",
    join: "miter",
    miterLimit: 4,
    dash: [],
  };

  it("clips its sublayer before drawing it, and strokes its Clipping Path after the clip is restored", () => {
    const log = clippedLayer({ type: "rect", x: 5, y: 5, width: 10, height: 10 });
    const ops = log.filter((l) => /^(save|restore|clip|fill$|stroke$)/.test(l));
    expect(ops).toEqual([
      "save",
      "save",
      "clip nonzero",
      // The sublayer and its rect, inside the clip.
      "save",
      "save",
      "fill",
      "restore",
      "restore",
      "restore",
      // The Clipping Path's Stroke, unclipped (ADR-0051).
      "save",
      "stroke",
      "restore",
      "restore",
    ]);
  });

  it("masks its content by a text Clipping Path's glyphs in a layer", () => {
    const log = clippedLayer({ type: "text", x: 5, y: 30, content: "Hi" });
    expect(log).not.toContainEqual(expect.stringMatching(/^(> )*clip/));
    const ops = log.filter((l) =>
      /^(> )*(layer|drawImage|fill$|globalCompositeOperation|strokeText)/.test(l),
    );
    expect(ops).toEqual([
      "layer",
      "> fill",
      "> globalCompositeOperation=destination-in",
      "layer",
      "> drawImage L2 0 0",
      "drawImage L1 0 0",
      "strokeText Hi 5 30",
    ]);
  });
});

describe("a text Clipping Path (ADR-0052)", () => {
  /** A red rect clipped by "Hi", its Clipping Path given `appearance`; `outer` strokes the rect's Group. */
  const clippedByText = (content = "Hi", appearance = {}, outer = false) => {
    const { doc, defaultLayerId: parentId } = newDoc();
    const red = { fills: [{ color: "#FF0000" }] };
    const [g, rect, text] = createNodes(doc, [
      {
        type: "group",
        parentId,
        appearance: { strokes: outer ? [{ color: "#DDDDDD", width: 4 }] : [] },
        children: [
          { type: "rect", x: 0, y: 0, width: 50, height: 50, appearance: red },
          { type: "text", x: 5, y: 30, content },
        ],
      },
    ] as never).nodes as Node[];
    if (!g || !rect || !text) throw new Error("setup");
    makeMask(doc, { clipNodeId: text.id, contentIds: [rect.id] });
    Object.assign(doc.nodes.get(text.id) as Node, {
      appearance: { fills: [], strokes: [], ...appearance },
    });
    const { ctx, log, layer } = recorder();
    drawDocument(ctx, doc, layer);
    return log;
  };

  it("masks by CJK glyphs in the same fallback order as the text draws (ADR-0063)", () => {
    const log = clippedByText("小");
    expect(log).toContain('> font=12px "Source Sans 3", "Noto Sans SC", "Noto Sans KR"');
    expect(log).toContain("> fillText 小 5 30");
  });

  it("draws the content in a layer masked by the glyphs, and the Strokes after, unclipped", () => {
    const log = clippedByText("Hi", {
      fills: [{ type: "solid", color: "#00FF00" }],
      strokes: [
        {
          type: "solid",
          color: "#0000FF",
          width: 2,
          cap: "butt",
          join: "miter",
          miterLimit: 4,
          dash: [],
        },
      ],
    });
    expect(log).not.toContainEqual(expect.stringMatching(/^(> )*clip/));
    const ops = log.filter((l) =>
      /^(> )*(layer|drawImage|fill$|fillStyle=#(FF0|00)|fillText|strokeText|globalCompositeOperation)/.test(
        l,
      ),
    );
    expect(ops).toEqual([
      "layer",
      // The Fill behind, then the content, then the glyph mask, all inside the layer.
      "> fillStyle=#00FF00",
      "> fillText Hi 5 30",
      "> fillStyle=#FF0000",
      "> fill",
      "> globalCompositeOperation=destination-in",
      // The glyphs in a layer of their own, which masks the first in one drawImage: each glyph
      // drawn under destination-in would clear the others.
      "layer",
      "> fillStyle=#000000",
      "> fillText Hi 5 30",
      "> drawImage L2 0 0",
      "drawImage L1 0 0",
      "strokeText Hi 5 30",
    ]);
  });

  it("draws nothing it clips when its glyphs cover nothing", () => {
    const log = clippedByText("   ");
    expect(log).not.toContain("layer");
    expect(log).not.toContain("fillStyle=#FF0000");
  });

  it("masks a container Stroke on a leaf it clips by the same glyphs", () => {
    const log = clippedByText("Hi", {}, true);
    const stroked = log.filter((l) =>
      /^(> )*(layer|drawImage|strokeStyle=#DDDDDD|stroke$|globalCompositeOperation|fillText)/.test(
        l,
      ),
    );
    // The content's layer first, then the Stroke's own.
    expect(stroked.slice(-8)).toEqual([
      "layer",
      "> strokeStyle=#DDDDDD",
      "> stroke",
      "> globalCompositeOperation=destination-in",
      "layer",
      "> fillText Hi 5 30",
      "> drawImage L4 0 0",
      "drawImage L3 0 0",
    ]);
  });
});

it.each([
  ["none", { x: 10, y: 10, width: 60, height: 40 }],
  ["xMidYMid meet", { x: 10, y: 20, width: 60, height: 20 }],
  ["xMaxYMin meet", { x: 10, y: 10, width: 60, height: 20 }],
  ["xMinYMax slice", { x: 10, y: 10, width: 120, height: 40 }],
  ["xMidYMid slice", { x: -20, y: 10, width: 120, height: 40 }],
])("places a 30 × 10 file in a 60 × 40 frame at (10, 10) under %s", (par, rect) => {
  expect(
    imagePlacement({ x: 10, y: 10, width: 60, height: 40 }, { width: 30, height: 10 }, par),
  ).toEqual(rect);
});

it("draws an Image once its file is decoded, clipped to its frame under slice", () => {
  const { doc, defaultLayerId } = newDoc();
  const src = "a".repeat(64);
  doc.images.set(src, { mime: "image/png", width: 30, height: 10 });
  const image = {
    type: "image",
    parentId: defaultLayerId,
    src,
    x: 10,
    y: 10,
    width: 60,
    height: 40,
  } as const;
  createNodes(doc, [image, { ...image, preserveAspectRatio: "xMidYMid slice" }]);
  const drawn = (images?: Parameters<typeof drawDocument>[3]) => {
    const { ctx, log, layer } = recorder();
    drawDocument(ctx, doc, layer, images);
    return log.filter((l) => /^(drawImage|rect|clip)/.test(l));
  };
  expect(drawn()).toEqual([]);
  expect(drawn((id) => (id === src ? { image: "IMG", width: 30, height: 10 } : undefined))).toEqual(
    ["drawImage IMG 10 10 60 40", "rect 10 10 60 40", "clip", "drawImage IMG -20 10 120 40"],
  );
});

it("draws a missing link as its frame and both diagonals, in a one-pixel stroke at any zoom (ADR-0042)", () => {
  const { doc, defaultLayerId } = newDoc();
  const src = "a".repeat(64);
  doc.images.set(src, { mime: "image/png", width: 30, height: 10 });
  const frame = {
    type: "image",
    parentId: defaultLayerId,
    x: 10,
    y: 10,
    width: 60,
    height: 40,
  } as const;
  const [missing, loading] = createNodes(doc, [
    { ...frame, file: "missing.png" },
    // Linked with pixels still loading: nothing, as an embedded Image.
    { ...frame, file: "linked.png", src },
  ]).nodes as [Node, Node];
  missing.transform = [2, 0, 0, 2, 5, 0];
  const frameBounds = { x: 25, y: 20, width: 120, height: 80 };
  expect([bounds(doc, missing), visibleBounds(doc, missing)]).toEqual([frameBounds, frameBounds]);
  const loadingBounds = { x: 10, y: 10, width: 60, height: 40 };
  expect([bounds(doc, loading), visibleBounds(doc, loading)]).toEqual([
    loadingBounds,
    loadingBounds,
  ]);
  const { ctx, log, layer } = recorder();
  drawDocument(ctx, doc, layer, () => undefined);
  // The Layer's and Image's transforms, then the device-space stroke, all inside their saves.
  expect(log.filter((l) => !/^(globalAlpha|fill)/.test(l))).toEqual([
    "save",
    "transform 1 0 0 1 0 0",
    "save",
    "transform 2 0 0 2 5 0",
    "beginPath",
    "moveTo 10 10",
    "lineTo 70 10",
    "lineTo 70 50",
    "lineTo 10 50",
    "closePath",
    "moveTo 10 10",
    "lineTo 70 50",
    "moveTo 70 10",
    "lineTo 10 50",
    "setTransform 1 0 0 1 0 0",
    "strokeStyle=#999999",
    "lineWidth=1",
    "setLineDash ",
    "stroke",
    "restore",
    "save",
    "transform 1 0 0 1 0 0",
    "restore",
    "restore",
  ]);
});

describe("gradients (ADR-0026)", () => {
  const stops = [
    { offset: 0, color: "#1F5FBF" },
    { offset: 1, color: "#9FD0FF00" },
  ];
  const drawn = (input: Record<string, unknown>) => {
    const { doc, defaultLayerId: parentId } = newDoc();
    createNodes(doc, [{ parentId, ...input } as never]);
    const { ctx, log, layer } = recorder();
    drawDocument(ctx, doc, layer);
    // After the background and the Layer's and the leaf's save and transform, before their restores.
    const body = log.filter((l) => !PATH_OPS.test(l) && !/^(globalAlpha|beginPath)/.test(l));
    return body.slice(6, -2);
  };
  const rect = { type: "rect", x: 10, y: 20, width: 100, height: 50 };

  it("fills with a linear gradient from start to end", () => {
    const fills = [{ type: "gradient", gradient: { type: "linear", stops } }];
    expect(drawn({ ...rect, appearance: { fills } })).toEqual([
      "createLinearGradient 10 45 110 45",
      "addColorStop 0 #1F5FBF",
      "addColorStop 1 #9FD0FF00",
      "fillStyle=[gradient]",
      "fill",
    ]);
  });

  it("fills an elliptical radial gradient under its ellipse only, and a circle without one", () => {
    const radial = {
      type: "radial",
      stops,
      radius: 40,
      aspectRatio: 0.5,
      angle: 30,
      focus: { x: 70, y: 45 },
    };
    const log = drawn({ ...rect, appearance: { fills: [{ type: "gradient", gradient: radial }] } });
    const n3 = (l: string) =>
      l.replace(/-?\d+\.\d+/g, (n) => String(Math.round(Number(n) * 1e3) / 1e3));
    expect(log.map(n3)).toEqual([
      // The focus back through the ellipse, which maps it to (70, 45).
      "createRadialGradient 68.66 35 0 60 45 40",
      "addColorStop 0 #1F5FBF",
      "addColorStop 1 #9FD0FF00",
      "fillStyle=[gradient]",
      "save",
      "transform 0.866 0.5 -0.25 0.433 19.288 -4.486",
      "fill",
      "restore",
    ]);
    const circle = drawn({
      ...rect,
      appearance: { fills: [{ type: "gradient", gradient: { type: "radial", stops } }] },
    });
    expect(circle.filter((l) => l.startsWith("transform"))).toEqual([]);
    expect(circle).toContain("createRadialGradient 60 45 0 60 45 39.528");
  });

  it("draws an elliptical radial gradient as its circle on a Stroke and on text", () => {
    const radial = {
      type: "gradient",
      gradient: {
        type: "radial",
        stops,
        radius: 40,
        aspectRatio: 0.5,
        angle: 30,
        center: { x: 60, y: 45 },
        focus: { x: 70, y: 45 },
      },
    };
    const stroked = drawn({
      ...rect,
      appearance: { fills: [], strokes: [{ ...radial, width: 3 }] },
    });
    const text = drawn({
      type: "text",
      x: 10,
      y: 50,
      content: "Hi",
      appearance: { fills: [radial] },
    });
    for (const log of [stroked, text]) {
      expect(log).toContain("createRadialGradient 70 45 0 60 45 40");
      expect(log.filter((l) => l.startsWith("transform"))).toEqual([]);
    }
  });

  it("strokes and fills text with a gradient", () => {
    const paint = { type: "gradient", gradient: { type: "linear", stops } };
    const stroked = drawn({
      ...rect,
      appearance: { fills: [], strokes: [{ ...paint, width: 3 }] },
    });
    expect(stroked).toEqual(
      expect.arrayContaining([
        "createLinearGradient 10 45 110 45",
        "strokeStyle=[gradient]",
        "lineWidth=3",
        "stroke",
      ]),
    );
    const text = drawn({
      type: "text",
      x: 10,
      y: 50,
      content: "Hi",
      appearance: { fills: [paint] },
    });
    expect(text.indexOf("fillStyle=[gradient]")).toBeLessThan(
      text.findIndex((l) => l.startsWith("fillText")),
    );
  });
});

describe("a subtree (ADR-0057)", () => {
  it("keeps the Document up to that Group where it paints, in its translucent, clipped parent", () => {
    const { doc, defaultLayerId: parentId } = newDoc();
    const fill = (color: string) => ({ fills: [{ color }], strokes: [] });
    const rect = (color: string) =>
      ({
        type: "rect",
        parentId,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        appearance: fill(color),
      }) as const;
    const { keyMap } = createNodes(doc, [
      rect("#00FF00"),
      { ...rect("#FFFF00"), clientKey: "content" },
      {
        type: "group",
        clientKey: "group",
        parentId,
        children: [
          { type: "rect", x: 0, y: 0, width: 10, height: 10, appearance: fill("#FF0000") },
        ],
      },
      { ...rect("#000000"), clientKey: "clip" },
    ] as never);
    const [content, group, clip] = [keyMap.content, keyMap.group, keyMap.clip] as [
      string,
      string,
      string,
    ];
    const { group: parent } = makeMask(doc, { clipNodeId: clip, contentIds: [content, group] });
    const stroke = { type: "solid", color: "#0000FF", width: 1, cap: "butt", join: "miter" };
    Object.assign(doc.nodes.get(clip) as Node, {
      appearance: { fills: [], strokes: [{ ...stroke, miterLimit: 10, dash: [] }] },
    });
    Object.assign(parent, { opacity: 0.5 });
    const { ctx, log, layer } = recorder();
    drawDocument(ctx, doc, layer, undefined, group);
    const wash = "fillStyle=rgba(255, 255, 255, 0.5)";
    expect(log.filter((l) => /(fill|stroke)Style=/.test(l))).toEqual([
      // The Group's coverage,
      "> fillStyle=#FF0000",
      // the Document over a copy of the canvas up to the Group, without the Clipping Path's
      // Stroke above it,
      "> fillStyle=#FFFFFF",
      "> fillStyle=#00FF00",
      "> fillStyle=#FFFF00",
      "> fillStyle=#FF0000",
      // and the rest, washed.
      "fillStyle=#FFFFFF",
      "fillStyle=#00FF00",
      "> fillStyle=#FFFF00",
      "> strokeStyle=#0000FF",
      wash,
    ]);
    // The coverage is clipped by the parent, but takes neither its opacity nor a layer for it.
    const copy = log.indexOf("> drawImage [canvas] 0 0");
    const coverage = log.slice(0, copy - 1);
    expect(log[copy - 1]).toBe("layer");
    expect(coverage.filter((l) => l === "layer")).toHaveLength(1);
    expect(coverage).toContain("> clip nonzero");
    expect(coverage).not.toContain("> globalAlpha=0.5");
    // The whole Document keeps only what the Group covers; the washed rest loses it; they add up.
    expect(log).toContain("> globalCompositeOperation=destination-in");
    expect(log.indexOf("> drawImage L1 0 0")).toBeGreaterThan(
      log.indexOf("> globalCompositeOperation=destination-in"),
    );
    expect(log.slice(log.indexOf(wash))).toEqual([
      wash,
      "fillRect 0 0 100 100",
      "globalCompositeOperation=destination-out",
      "drawImage L1 0 0",
      "globalCompositeOperation=lighter",
      "drawImage L2 0 0",
      "restore",
    ]);
    // Without it the whole scene draws once, the Artboard's background first.
    const whole = recorder();
    drawDocument(whole.ctx, doc, whole.layer);
    expect(whole.log[0]).toBe("fillStyle=#FFFFFF");
    expect(whole.log.filter((l) => /(fill|stroke)Style=/.test(l))).toHaveLength(5);
    expect(whole.log).not.toContain(wash);
  });

  it("draws a sub-Layer or a leaf in its translucent, clipped Layer the same way (ADR-0058)", () => {
    const { doc, defaultLayerId: l } = newDoc();
    const rect = (color: string, extra = {}) =>
      ({
        type: "rect",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        appearance: { fills: [{ color }], strokes: [] },
        ...extra,
      }) as const;
    const { keyMap } = createNodes(doc, [
      { type: "layer", clientKey: "sub", parentId: l },
      { ...rect("#000000"), parentId: l },
    ] as never);
    const sub = keyMap.sub as string;
    const [leaf] = createNodes(doc, [
      { ...rect("#FF0000"), parentId: sub },
      { ...rect("#00FF00"), parentId: sub },
    ] as never).nodes as [Node];
    makeMask(doc, { layerId: l });
    Object.assign(doc.nodes.get(l) as Node, { opacity: 0.5 });
    /** What the isolated Node's coverage draws, before the canvas is copied. */
    const coverage = (id: string) => {
      const { ctx, log, layer } = recorder();
      drawDocument(ctx, doc, layer, undefined, id);
      return log.slice(0, log.indexOf("> drawImage [canvas] 0 0") - 1);
    };
    for (const [id, fills] of [
      [sub, ["> fillStyle=#FF0000", "> fillStyle=#00FF00"]],
      [leaf.id, ["> fillStyle=#FF0000"]],
    ] as const) {
      const drawn = coverage(id);
      // Only that Node, clipped by the Layer, without the Layer's opacity.
      expect(drawn.filter((l) => /fillStyle=/.test(l))).toEqual(fills);
      expect(drawn).toContain("> clip nonzero");
      expect(drawn).not.toContain("> globalAlpha=0.5");
    }
  });
});

describe("a character no bundled face has (ADR-0065)", () => {
  /** Draws `nodes` and returns the log from the first text's font on. */
  const drawnText = (nodes: object[]) => {
    const { doc, defaultLayerId: parentId } = newDoc();
    const created = createNodes(doc, nodes.map((n) => ({ parentId, ...n })) as never).nodes;
    const { ctx, log, layer } = recorder();
    drawDocument(ctx, doc, layer);
    return { doc, created: created as Node[], log };
  };
  const text = (content: string, more: object = {}) => ({
    type: "text",
    x: 10,
    y: 50,
    content,
    appearance: { fills: [{ color: "#000000" }], strokes: [] },
    ...more,
  });
  const at = (l: string) => l.split(" ").slice(1).map(Number);
  /** The text arguments of every fillText and strokeText. */
  const painted = (log: string[]) =>
    log.flatMap((l) => {
      const m = /^(?:> )*(?:fill|stroke)Text (.*) \S+ \S+$/.exec(l);
      return m ? [m[1]] : [];
    });
  /** Where each traced `.notdef` box starts: Source Sans 3 Regular's at (89, 0), in 12 pt. */
  const boxes = (log: string[]) =>
    log.flatMap((l, i) =>
      /^(> )*beginPath$/.test(l) ? [at((log[i + 1] ?? "").replace(/^(> )*/, ""))] : [],
    );
  const glyphX = (doc: ReturnType<typeof newDoc>["doc"], id: string, i: number) =>
    glyphs(doc.nodes.get(id) as never)[i]?.x as number;

  it("splits a plain line into runs around a box at the glyph's origin, asking no font for it", () => {
    for (const missing of ["😀", "ก"]) {
      const { doc, created, log } = drawnText([text(`A${missing}B`)]);
      const id = created[0]?.id as string;
      expect(painted(log)).toEqual(["A", "B"]);
      const [a, box, b] = [0, 1, 2].map((i) => glyphX(doc, id, i));
      expect(log).toContain(`fillText A ${a} 50`);
      expect(log).toContain(`fillText B ${b} 50`);
      // The box is Source Sans 3 Regular's .notdef, 653 units wide: B follows at its advance.
      expect((b as number) - (box as number)).toBeCloseTo(653 * 0.012, 9);
      expect(boxes(log)).toEqual([[expect.closeTo((box as number) + 89 * 0.012, 9), 50]]);
      const fill = log.indexOf("fill");
      expect(fill).toBeGreaterThan(log.findIndex((l) => l.startsWith("moveTo")));
      expect(fill).toBeLessThan(log.indexOf(`fillText B ${b} 50`));
    }
  });

  it("paints a line without one in one fillText, as before", () => {
    const { log } = drawnText([text("AB\nA😀")]);
    expect(painted(log)).toEqual(["AB", "A"]);
  });

  it("paints Hangul as a glyph, not a box, since Noto Sans KR has it (ADR-0066)", () => {
    const { log } = drawnText([text("A한B")]);
    expect(painted(log)).toEqual(["A한B"]);
    expect(boxes(log)).toEqual([]);
  });

  it("strokes the box on a Stroke, as strokeText strokes a glyph", () => {
    const { log } = drawnText([
      text("A😀", { appearance: { fills: [], strokes: [{ color: "#0000FF", width: 1 }] } }),
    ]);
    expect(painted(log)).toEqual(["A"]);
    expect(boxes(log)).toHaveLength(1);
    expect(log.filter((l) => !/^(save|restore)$/.test(l)).at(-1)).toBe("stroke");
  });

  it("draws a box per character on the tracked path too, at the tracked origin", () => {
    const { doc, created, log } = drawnText([text("A😀B", { tracking: 100 })]);
    expect(painted(log)).toEqual(["A", "B"]);
    const box = glyphX(doc, created[0]?.id as string, 1);
    expect(boxes(log)).toEqual([[expect.closeTo(box + 89 * 0.012, 9), 50]]);
  });

  it("draws the box of a Noto Sans SC text's own first family, 1000 units wide", () => {
    const { doc, created, log } = drawnText([text("😀B", { fontFamily: "Noto Sans SC" })]);
    expect(glyphX(doc, created[0]?.id as string, 1)).toBeCloseTo(10 + 12, 9);
    // Noto Sans SC's .notdef starts at (100, -120).
    expect(boxes(log)).toEqual([[expect.closeTo(10 + 1.2, 9), expect.closeTo(50 + 1.44, 9)]]);
  });

  it("paints the box in a container's paint copies", () => {
    const { log } = drawnText([
      {
        type: "group",
        appearance: { fills: [{ color: "#CCCCCC" }], strokes: [], contents: 0 },
        children: [text("😀", { appearance: { fills: [], strokes: [] } })],
      },
    ]);
    expect(painted(log)).toEqual([]);
    expect(boxes(log)).toHaveLength(1);
    expect(log.slice(log.indexOf("fillStyle=#CCCCCC"))).toContain("fill");
  });

  it("masks by the box in a text Clipping Path", () => {
    const { doc, defaultLayerId: parentId } = newDoc();
    const [, rect, clip] = createNodes(doc, [
      {
        type: "group",
        parentId,
        children: [
          { type: "rect", x: 0, y: 0, width: 50, height: 50 },
          { type: "text", x: 5, y: 30, content: "A😀" },
        ],
      },
    ] as never).nodes as Node[];
    if (!rect || !clip) throw new Error("setup");
    makeMask(doc, { clipNodeId: clip.id, contentIds: [rect.id] });
    const { ctx, log, layer } = recorder();
    drawDocument(ctx, doc, layer);
    const mask = log.slice(log.lastIndexOf("layer"));
    expect(painted(mask)).toEqual(["A"]);
    expect(boxes(mask)).toHaveLength(1);
    expect(mask).toContain("> fill");
  });
});
