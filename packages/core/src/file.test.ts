import { describe, expect, it } from "vitest";
import { RED_2x2_PNG, WEBP_HEADER } from "../../../fixtures/images.ts";
import { createDocument, createNodes } from "./document.ts";
import { KalamoError } from "./errors.ts";
import { type Migration, parseDocument, resolveImages, serializeDocument } from "./file.ts";
import { imageId, readImage } from "./image.ts";
import type { Document, Node } from "./schema.ts";

/** A Layer holding a Group (a rect and a text) and a path. */
function scene(): Document {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
  });
  createNodes(doc, [
    {
      type: "group",
      parentId: defaultLayerId,
      children: [
        { type: "rect", x: 10, y: 10, width: 50, height: 30, meta: { z: 1, a: 2 } },
        { type: "text", x: 10, y: 80, content: "Hi" },
      ],
    },
    { type: "path", parentId: defaultLayerId, d: "M 0 0 L 10 0 L 10 10 Z" },
  ]);
  return doc;
}

const sorted = (keys: string[]) => [...keys].sort();

it("serialises version, name, artboards and nodes, sorted, with a final newline", () => {
  const text = serializeDocument(scene());
  expect(text.startsWith('{\n  "version": 1,\n  "name": "Doc",')).toBe(true);
  expect(text.endsWith("}\n")).toBe(true);
  const file = JSON.parse(text);
  expect(Object.keys(file)).toEqual(["version", "name", "artboards", "nodes"]);
  const ids = file.nodes.map((n: { id: string }) => n.id);
  expect(ids).toEqual(sorted(ids));
  expect(ids).toHaveLength(5);
  for (const node of file.nodes) {
    expect(Object.keys(node)).toEqual(sorted(Object.keys(node)));
    for (const fill of node.appearance?.fills ?? []) {
      expect(Object.keys(fill)).toEqual(sorted(Object.keys(fill)));
    }
  }
  expect(Object.keys(file.nodes.find((n: { type: string }) => n.type === "rect").meta)).toEqual([
    "a",
    "z",
  ]);
  expect(file).not.toHaveProperty("id");
  expect(file).not.toHaveProperty("rev");
});

it("gives the same text however the Nodes' keys were ordered", () => {
  const doc = scene();
  const reordered: Document = {
    ...doc,
    rev: 7,
    nodes: new Map(
      [...doc.nodes]
        .reverse()
        .map(([id, n]) => [id, Object.fromEntries(Object.entries(n).reverse())]),
    ) as Document["nodes"],
  };
  expect(serializeDocument(reordered)).toBe(serializeDocument(doc));
});

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof KalamoError) return e.data;
    throw e;
  }
  throw new Error("expected a KalamoError");
};

it("parses what it serialises back to the same Document, and the same text", () => {
  const doc = scene();
  const text = serializeDocument(doc);
  const parsed = parseDocument(text);
  expect(parsed.name).toBe("Doc");
  expect(parsed.artboards).toEqual(doc.artboards);
  expect(new Map(parsed.nodes.map((n) => [n.id, n]))).toEqual(doc.nodes);
  const reopened: Document = {
    ...doc,
    id: "other",
    rev: 1,
    nodes: new Map(parsed.nodes.map((n) => [n.id, n])),
  };
  expect(serializeDocument(reopened)).toBe(text);
});

it("reads a Layer's and a Group's Appearance back as written, and a file without one unchanged", () => {
  const doc = scene();
  const [layer, group] = [...doc.nodes.values()];
  if (layer?.type !== "layer" || group?.type !== "group") throw new Error("setup");
  const before = JSON.parse(serializeDocument(doc)).nodes;
  expect(before.find((n: Node) => n.id === layer.id)).not.toHaveProperty("appearance");
  group.appearance = {
    fills: [{ type: "solid", color: "#00FF00" }],
    strokes: [
      {
        type: "solid",
        color: "#FF0000",
        width: 2,
        cap: "butt",
        join: "miter",
        miterLimit: 10,
        dash: [],
      },
    ],
    contents: 1,
  };
  const text = serializeDocument(doc);
  expect(new Map(parseDocument(text).nodes.map((n) => [n.id, n]))).toEqual(doc.nodes);
  const file = JSON.parse(text);
  file.nodes.find((n: Node) => n.id === group.id).appearance.contents = 3;
  expect(errorOf(() => parseDocument(JSON.stringify(file)))).toMatchObject({
    code: "INVALID_DOCUMENT",
    path: expect.stringMatching(/^nodes\[\d+\]\.appearance\.contents$/),
  });
});

it("reads a text's explicit left alignment as none, so it serialises as it would have (ADR-0077)", () => {
  const doc = scene();
  const text = serializeDocument(doc);
  const file = JSON.parse(text);
  const t = file.nodes.find((n: Node) => n.type === "text");
  const left = {
    ...file,
    nodes: file.nodes.map((n: Node) => (n === t ? { ...n, alignment: "left" } : n)),
  };
  const parsed = parseDocument(JSON.stringify(left));
  expect(parsed.nodes.find((n) => n.type === "text")).not.toHaveProperty("alignment");
  expect(serializeDocument({ ...doc, nodes: new Map(parsed.nodes.map((n) => [n.id, n])) })).toBe(
    text,
  );
});

it("reads a Path without fillRule as nonzero and keeps evenodd", () => {
  const file = JSON.parse(serializeDocument(scene()));
  const path = file.nodes.find((n: { type: string }) => n.type === "path");
  expect(path.fillRule).toBe("nonzero");
  delete path.fillRule;
  const rule = (text: string) => parseDocument(text).nodes.find((n) => n.type === "path");
  expect(rule(JSON.stringify(file))).toMatchObject({ fillRule: "nonzero" });
  path.fillRule = "evenodd";
  expect(rule(JSON.stringify(file))).toMatchObject({ fillRule: "evenodd" });
});

it("reads a star, a polygon and an ellipse written before ADR-0024 and ADR-0025 with defaults", () => {
  const file = JSON.parse(serializeDocument(scene()));
  const path = file.nodes.find((n: { type: string }) => n.type === "path");
  const { d: _d, fillRule: _rule, ...base } = path;
  const at = { cx: 0, cy: 0, index: "az", parentId: path.parentId };
  file.nodes.push(
    {
      ...base,
      ...at,
      id: "01M38T29SRSTAR0000000000A0",
      type: "star",
      outerRadius: 9,
      innerRadius: 4,
      points: 5,
    },
    {
      ...base,
      ...at,
      id: "01M38T29SRPENTAG0N000000A1",
      index: "azV",
      type: "polygon",
      radius: 9,
      sides: 6,
    },
    {
      ...base,
      id: "01M38T29SRSTAR0000000000A2",
      index: "azW",
      parentId: path.parentId,
      type: "ellipse",
      x: 0,
      y: 0,
      width: 9,
      height: 6,
    },
  );
  const [star, polygon, ellipse] = parseDocument(JSON.stringify(file)).nodes.filter(
    (n) => n.type === "star" || n.type === "polygon" || n.type === "ellipse",
  );
  expect(star).toMatchObject({ angle: 0, twist: 0, rounded: 0, randomized: 0 });
  expect(polygon).toMatchObject({ angle: 0, rounded: 0, randomized: 0 });
  // Before ADR-0025 an ellipse had no angles: it opens whole.
  expect(ellipse).toMatchObject({ startAngle: 0, endAngle: 360, arcType: "slice" });
});

describe("gradients", () => {
  const stops = [
    { offset: 0, color: "#1F5FBF" },
    { offset: 1, color: "#9FD0FF00" },
  ];
  const linear = { type: "linear", stops, start: { x: 0, y: 5 }, end: { x: 20, y: 5 } };
  const withGradient = () => {
    const doc = scene();
    const rect = [...doc.nodes.values()].find((n) => n.type === "rect");
    if (rect?.type !== "rect") throw new Error("setup");
    rect.appearance.fills = [{ type: "gradient", gradient: linear as never }];
    return { doc, rect };
  };

  it("reads a gradient Fill back as it was written", () => {
    const { doc, rect } = withGradient();
    const back = parseDocument(serializeDocument(doc)).nodes.find((n) => n.id === rect.id);
    expect(back).toMatchObject({ appearance: { fills: [{ type: "gradient", gradient: linear }] } });
  });

  it("reads a Stroke written before ADR-0026, without a type, as solid", () => {
    const file = JSON.parse(serializeDocument(scene()));
    const rect = file.nodes.find((n: { type: string }) => n.type === "rect");
    delete rect.appearance.strokes[0].type;
    const back = parseDocument(JSON.stringify(file)).nodes.find((n) => n.id === rect.id);
    expect(back).toMatchObject({ appearance: { strokes: [{ type: "solid", color: "#000000" }] } });
  });

  it("refuses a stored gradient without its geometry", () => {
    const { doc, rect } = withGradient();
    const file = JSON.parse(serializeDocument(doc));
    const i = file.nodes.findIndex((n: { id: string }) => n.id === rect.id);
    delete file.nodes[i].appearance.fills[0].gradient.end;
    expect(() => parseDocument(JSON.stringify(file))).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({
          code: "INVALID_DOCUMENT",
          path: `nodes[${i}].appearance.fills[0].gradient.end`,
        }),
      }),
    );
  });
});

describe("migrations", () => {
  // A test migration: version 1 called the name `title`.
  const up: Migration = ({ title, ...rest }) => ({ ...rest, name: title });
  const v1 = (() => {
    const { name, ...rest } = JSON.parse(serializeDocument(scene()));
    return { ...rest, title: name };
  })();
  const text = (file: object) => JSON.stringify(file);

  it("runs the up migration of an older version before validating", () => {
    expect(parseDocument(text(v1), [up]).name).toBe("Doc");
    expect(errorOf(() => parseDocument(text(v1)))).toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("does not migrate a file already at the current version", () => {
    const { title, ...rest } = v1;
    const current = { ...rest, version: 2, name: title };
    const never: Migration = () => {
      throw new Error("ran");
    };
    expect(parseDocument(text(current), [never]).name).toBe("Doc");
  });

  it.each([
    [3, [up]],
    [2, []],
  ])("refuses version %s, newer than this build, with no downgrade", (version, migrations) => {
    expect(errorOf(() => parseDocument(text({ ...v1, version }), migrations))).toMatchObject({
      code: "INVALID_DOCUMENT",
      path: "version",
      hint: expect.stringMatching(/newer/),
    });
  });

  it.each([0, 1.5, "1"])("refuses version %j", (version) => {
    expect(errorOf(() => parseDocument(text({ ...v1, version }), [up]))).toMatchObject({
      code: "INVALID_DOCUMENT",
      path: "version",
    });
  });
});

describe("validation", () => {
  const good = () => JSON.parse(serializeDocument(scene()));
  type File = ReturnType<typeof good>;
  type N = Record<string, unknown> & { id: string; type: string; parentId: string | null };
  const byType = (f: File, type: string): N => f.nodes.find((n: N) => n.type === type);
  const at = (f: File, n: N) => f.nodes.indexOf(n);

  it.each<[string, (f: File) => string | File, string, (f: File) => string]>([
    ["text that is not JSON", () => "{", "INVALID_DOCUMENT", () => "content"],
    ["an array", () => "[]", "INVALID_DOCUMENT", () => "content"],
    ["an unknown top-level key", (f) => ({ ...f, foo: 1 }), "INVALID_DOCUMENT", () => "foo"],
    [
      "an unknown Node key",
      (f) => {
        byType(f, "rect").foo = 1;
        return f;
      },
      "INVALID_DOCUMENT",
      (f) => `nodes[${at(f, byType(f, "rect"))}].foo`,
    ],
    [
      "a rect at the root",
      (f) => {
        byType(f, "rect").parentId = null;
        return f;
      },
      "INVALID_PARENT",
      (f) => `nodes[${at(f, byType(f, "rect"))}].parentId`,
    ],
    [
      "a parentId naming no Node",
      (f) => {
        byType(f, "rect").parentId = "nope";
        return f;
      },
      "INVALID_DOCUMENT",
      (f) => `nodes[${at(f, byType(f, "rect"))}].parentId`,
    ],
    [
      "a parentId naming an Artboard",
      (f) => {
        byType(f, "rect").parentId = f.artboards[0].id;
        return f;
      },
      "INVALID_PARENT",
      (f) => `nodes[${at(f, byType(f, "rect"))}].parentId`,
    ],
    [
      "a Group whose parent chain is a cycle",
      (f) => {
        const group = byType(f, "group");
        const other = { ...group, id: "0", parentId: group.id, index: "a0" };
        group.parentId = other.id;
        f.nodes.unshift(other);
        return f;
      },
      "INVALID_PARENT",
      () => "nodes[0].parentId",
    ],
    [
      "a duplicate id",
      (f) => ({ ...f, nodes: [...f.nodes, f.nodes[0]] }),
      "INVALID_DOCUMENT",
      (f) => `nodes[${f.nodes.length}].id`,
    ],
    [
      "a duplicate Artboard id",
      (f) => ({ ...f, artboards: [f.artboards[0], f.artboards[0]] }),
      "INVALID_DOCUMENT",
      () => "artboards[1].id",
    ],
    [
      "an index that is no fractional-index key",
      (f) => {
        byType(f, "rect").index = "!";
        return f;
      },
      "INVALID_DOCUMENT",
      (f) => `nodes[${at(f, byType(f, "rect"))}].index`,
    ],
    [
      "two siblings with one index",
      (f) => {
        byType(f, "path").index = byType(f, "group").index;
        return f;
      },
      "INVALID_DOCUMENT",
      (f) => `nodes[${Math.max(at(f, byType(f, "path")), at(f, byType(f, "group")))}].index`,
    ],
    [
      "a named colour",
      (f) => {
        (byType(f, "rect").appearance as { fills: { color: string }[] }).fills[0] = {
          type: "solid",
          color: "red",
        } as never;
        return f;
      },
      "INVALID_COLOR",
      (f) => `nodes[${at(f, byType(f, "rect"))}].appearance.fills[0].color`,
    ],
    [
      "relative path data",
      (f) => {
        byType(f, "path").d = "h 1";
        return f;
      },
      "INVALID_PATH",
      (f) => `nodes[${at(f, byType(f, "path"))}].d`,
    ],
    ["no Artboard", (f) => ({ ...f, artboards: [] }), "INVALID_DOCUMENT", () => "artboards"],
    ["no Node", (f) => ({ ...f, nodes: [] }), "INVALID_DOCUMENT", () => "nodes"],
    [
      "a named Artboard background",
      (f) => {
        f.artboards[0].background = "white";
        return f;
      },
      "INVALID_COLOR",
      () => "artboards[0].background",
    ],
    [
      "a clipping text beside a clipping rect",
      (f) => {
        byType(f, "text").clipping = true;
        byType(f, "rect").clipping = true;
        return f;
      },
      "INVALID_DOCUMENT",
      (f) => `nodes[${Math.max(at(f, byType(f, "text")), at(f, byType(f, "rect")))}].clipping`,
    ],
    [
      "two Clipping Paths in one Layer (ADR-0053)",
      (f) => {
        const path = byType(f, "path");
        path.clipping = true;
        f.nodes.push({ ...path, id: "~second", index: "a9" });
        return f;
      },
      "INVALID_DOCUMENT",
      (f) => `nodes[${f.nodes.length - 1}].clipping`,
    ],
    [
      "two Clipping Paths in one Group",
      (f) => {
        const rect = byType(f, "rect");
        rect.clipping = true;
        f.nodes.push({ ...rect, id: "~second", index: "a9" });
        return f;
      },
      "INVALID_DOCUMENT",
      (f) => `nodes[${f.nodes.length - 1}].clipping`,
    ],
    [
      "a Point Type with a frame",
      (f) => {
        Object.assign(byType(f, "text"), { width: 10, height: 10 });
        return f;
      },
      "INVALID_DOCUMENT",
      (f) => `nodes[${at(f, byType(f, "text"))}].width`,
    ],
    [
      "an Area Type without height",
      (f) => {
        Object.assign(byType(f, "text"), { kind: "area", width: 10 });
        return f;
      },
      "INVALID_DOCUMENT",
      (f) => `nodes[${at(f, byType(f, "text"))}].height`,
    ],
    [
      "a Character Range past the content's end",
      (f) => {
        byType(f, "text").ranges = [{ start: 0, end: 99 }];
        return f;
      },
      "INVALID_DOCUMENT",
      (f) => `nodes[${at(f, byType(f, "text"))}].ranges[0].end`,
    ],
    [
      "a hidden Clipping Path",
      (f) => {
        Object.assign(byType(f, "rect"), { clipping: true, visible: false });
        return f;
      },
      "INVALID_DOCUMENT",
      (f) => `nodes[${at(f, byType(f, "rect"))}].visible`,
    ],
  ])("rejects %s", (_, change, code, path) => {
    const file = good();
    const changed = change(file);
    const content = typeof changed === "string" ? changed : JSON.stringify(changed);
    expect(errorOf(() => parseDocument(content))).toMatchObject({
      code,
      path: path(file),
      hint: expect.stringMatching(/\S/),
    });
  });
});

// The path is a Layer's child: a Layer Clipping Mask (ADR-0053).
it.each(["rect", "text", "path"])(
  "reads a Clipping Mask of a %s back as it was written",
  (type) => {
    const f = JSON.parse(serializeDocument(scene()));
    f.nodes.find((n: { type: string }) => n.type === type).clipping = true;
    const text = JSON.stringify(f, null, 2);
    const { nodes } = parseDocument(text);
    expect(nodes.find((n) => n.type === type)).toMatchObject({ clipping: true });
  },
);

it("reads Area Type back with its frame and no leading", () => {
  const f = JSON.parse(serializeDocument(scene()));
  Object.assign(
    f.nodes.find((n: { type: string }) => n.type === "text"),
    {
      kind: "area",
      width: 100,
      height: 40,
      content: "a\nb",
    },
  );
  const { nodes } = parseDocument(JSON.stringify(f));
  const area = nodes.find((n) => n.type === "text");
  expect(area).toMatchObject({ kind: "area", width: 100, height: 40, content: "a\nb" });
  expect(area).not.toHaveProperty("leading");
});

it("reads overlapping Character Ranges back canonical", () => {
  const f = JSON.parse(serializeDocument(scene()));
  f.nodes.find((n: { type: string }) => n.type === "text").ranges = [
    { start: 0, end: 2, fill: "#FF0000" },
    { start: 1, end: 2, rotation: 5 },
  ];
  const { nodes } = parseDocument(JSON.stringify(f));
  expect(nodes.find((n) => n.type === "text")).toHaveProperty("ranges", [
    { start: 0, end: 1, fill: "#FF0000" },
    { start: 1, end: 2, fill: "#FF0000", rotation: 5 },
  ]);
});

describe("images", () => {
  const ID = "a".repeat(64);
  /** Two Images sharing one file, as node_create leaves them. */
  const withImages = () => {
    const doc = scene();
    const layer = [...doc.nodes.values()].find((n) => n.type === "layer")?.id as string;
    doc.images.set(ID, { mime: "image/png", width: 2, height: 2 });
    const image = { type: "image", parentId: layer, src: ID, x: 0, y: 0 } as const;
    createNodes(doc, [image, { ...image, x: 5 }]);
    return doc;
  };
  const provider = (id: string) => (id === ID ? RED_2x2_PNG : undefined);
  type Raw = { images: Record<string, string>; nodes: Record<string, unknown>[] };
  const file = (edit: (raw: Raw) => void) => {
    const raw = JSON.parse(serializeDocument(withImages(), provider));
    edit(raw);
    return JSON.stringify(raw);
  };

  it("holds each file once, after nodes, and nothing for a Document without Images", () => {
    const text = serializeDocument(withImages(), provider);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "version",
      "name",
      "artboards",
      "nodes",
      "images",
    ]);
    expect(JSON.parse(text).images).toEqual({ [ID]: RED_2x2_PNG });
    expect(JSON.parse(text).version).toBe(1);
    expect(Object.keys(JSON.parse(serializeDocument(scene())))).not.toContain("images");
  });

  it("reads the files back with their pixel size, and writes the same text", () => {
    const doc = withImages();
    const text = serializeDocument(doc, provider);
    const parsed = parseDocument(text);
    expect(parsed.images.get(ID)).toMatchObject({ mime: "image/png", width: 2, height: 2 });
    const reopened = { ...doc, nodes: new Map(parsed.nodes.map((n) => [n.id, n])) };
    expect(serializeDocument(reopened, provider)).toBe(text);
  });

  it("keeps a linked Image's file, and a missing link with no src and no entry (ADR-0042)", () => {
    const doc = withImages();
    const layer = [...doc.nodes.values()].find((n) => n.type === "layer")?.id as string;
    createNodes(doc, [
      { type: "image", parentId: layer, src: ID, file: "a.png", x: 0, y: 0 },
      { type: "image", parentId: layer, file: "../gone.png", x: 0, y: 0, width: 4, height: 2 },
    ]);
    // Only the pixels are asked for: the missing link names no id.
    const text = serializeDocument(doc, provider);
    const raw = JSON.parse(text);
    expect(raw.version).toBe(1);
    expect(raw.images).toEqual({ [ID]: RED_2x2_PNG });
    expect(raw.nodes).toContainEqual(expect.objectContaining({ src: ID, file: "a.png" }));
    const missing = raw.nodes.find((n: { file?: string }) => n.file === "../gone.png");
    expect(missing).not.toHaveProperty("src");
    const parsed = parseDocument(text);
    const reopened = { ...doc, nodes: new Map(parsed.nodes.map((n) => [n.id, n])) };
    expect(serializeDocument(reopened, provider)).toBe(text);
  });

  it("needs the file of every Image to write", () => {
    expect(errorOf(() => serializeDocument(withImages()))).toMatchObject({ code: "INVALID_IMAGE" });
  });

  it.each<[string, (raw: Raw) => unknown, RegExp]>([
    ["an Image whose file is missing", (raw: Raw) => delete raw.images[ID], /^nodes\[\d+\]\.src$/],
    [
      "a file no Image uses",
      (raw: Raw) => (raw.images["b".repeat(64)] = RED_2x2_PNG),
      /^images\.b+$/,
    ],
    ["a key that is not an id", (raw: Raw) => (raw.images.x = RED_2x2_PNG), /^images/],
    ["a WebP", (raw: Raw) => (raw.images[ID] = WEBP_HEADER), new RegExp(`^images\\.${ID}$`)],
    [
      "a file over 5 MB",
      (raw: Raw) =>
        (raw.images[ID] =
          `data:image/png;base64,${new Uint8Array(5 * 1024 * 1024 + 3).toBase64()}`),
      new RegExp(`^images\\.${ID}$`),
    ],
    [
      "an Image with neither src nor file",
      (raw: Raw) => delete raw.nodes.find((n) => n.src)?.src,
      /^nodes\[\d+\]\.src$/,
    ],
    ...["", " ", "data:image/png;base64,AAAA", "a".repeat(2049)].map(
      (f) =>
        [
          `the file ${JSON.stringify(f.slice(0, 12))}`,
          (raw: Raw) => Object.assign(raw.nodes.find((n) => n.src) ?? {}, { file: f }),
          /^nodes\[\d+\]\.file$/,
        ] satisfies [string, (raw: Raw) => unknown, RegExp],
    ),
    [
      "an unspelled preserveAspectRatio",
      (raw: Raw) =>
        Object.assign(raw.nodes.find((n) => n.src) ?? {}, { preserveAspectRatio: "xMidYMid" }),
      /preserveAspectRatio$/,
    ],
  ])("refuses %s", (_, edit, path) => {
    expect(errorOf(() => parseDocument(file(edit)))).toMatchObject({
      code: "INVALID_DOCUMENT",
      path: expect.stringMatching(path),
    });
  });
});

describe("resolveImages", () => {
  const png = () => readImage(RED_2x2_PNG, "src");
  const layer = { id: "L", type: "layer", name: "", parentId: null, index: "a0" } as const;
  const image = (id: string, src: string) =>
    ({
      ...layer,
      id,
      type: "image",
      parentId: "L",
      src,
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      preserveAspectRatio: "none",
    }) as unknown as Node;

  it("names each pending file by its SHA-256, merging two copies of one file", async () => {
    const id = await imageId(png().bytes);
    const file = {
      nodes: [layer as unknown as Node, image("A", "pending:1"), image("B", "pending:2")],
      images: new Map([
        ["pending:1", png()],
        ["pending:2", png()],
      ]),
    };
    const out = await resolveImages(file);
    expect(out.nodes.map((n) => (n.type === "image" ? n.src : null))).toEqual([null, id, id]);
    expect([...out.images.keys()]).toEqual([id]);
  });

  it("keeps a claimed id that is right, and refuses one that is not", async () => {
    const id = await imageId(png().bytes);
    const right = { nodes: [image("A", id)], images: new Map([[id, png()]]) };
    expect(await resolveImages(right)).toEqual(right);
    const wrong = "b".repeat(64);
    await expect(
      resolveImages({ nodes: [image("A", wrong)], images: new Map([[wrong, png()]]) }),
    ).rejects.toMatchObject({
      data: {
        code: "INVALID_DOCUMENT",
        path: `images.${wrong}`,
        message: expect.stringContaining(id),
      },
    });
  });
});

it("opens and saves a container gradient unchanged (#107)", () => {
  const doc = scene();
  const file = JSON.parse(serializeDocument(doc));
  const stops = [
    { offset: 0, color: "#000000FF" },
    { offset: 1, color: "#FFFFFFFF" },
  ];
  const linear = { type: "linear", stops, start: { x: 0, y: 0 }, end: { x: 1, y: 0 } };
  const radial = {
    type: "radial",
    stops,
    center: { x: 5, y: 5 },
    radius: 4,
    aspectRatio: 0.5,
    angle: 30,
    focus: { x: 6, y: 5 },
  };
  const group = file.nodes.find((n: Node) => n.type === "group");
  group.appearance = {
    fills: [{ type: "gradient", gradient: linear }],
    strokes: [
      {
        type: "gradient",
        gradient: radial,
        width: 2,
        cap: "round",
        join: "bevel",
        miterLimit: 4,
        dash: [1, 2],
      },
    ],
    contents: 1,
  };
  const text = JSON.stringify(file);
  const opened = parseDocument(text).nodes.find((n) => n.id === group.id);
  expect(opened).toMatchObject({ appearance: group.appearance });
  expect(
    JSON.parse(
      serializeDocument({
        ...doc,
        nodes: new Map(parseDocument(text).nodes.map((n) => [n.id, n])),
      }),
    ).nodes.find((n: Node) => n.id === group.id),
  ).toEqual(group);
});
