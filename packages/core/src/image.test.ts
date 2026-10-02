import { describe, expect, it } from "vitest";
import {
  orientedJpeg,
  QUADRANTS_8x4_JPEG,
  RED_2x2_PNG,
  UPRIGHT_QUADRANTS,
  WEBP_LOSSLESS_4x3,
  WEBP_LOSSY_4x3,
} from "../../../fixtures/images.ts";
import {
  aspectPlacement,
  checkImage,
  dataUrl,
  imageId,
  inverseOrientation,
  MAX_IMAGE_BYTES,
  neutraliseOrientation,
  type Orientation,
  orientedImage,
  orientImage,
  preserveAspectRatio,
  readImage,
} from "./image.ts";
import { applyTo } from "./matrix.ts";
import type { Matrix } from "./schema.ts";

const url = (bytes: number[] | Uint8Array, mime = "image/png") =>
  `data:${mime};base64,${new Uint8Array(bytes).toBase64()}`;
const u16be = (n: number) => [n >> 8, n & 255];
const u32be = (n: number) => [0, 0, ...u16be(n)];
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG = [...SIGNATURE, ...u32be(13), ...[73, 72, 68, 82], ...u32be(2), ...u32be(3)];
const jpeg = (sof: number) => [
  ...[0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Array(14).fill(0)],
  ...[0xff, sof, 0, 17, 8, ...u16be(7), ...u16be(9)],
];
const GIF = [...new TextEncoder().encode("GIF89a"), 4, 0, 5, 0];
const invalid = (hint = expect.any(String)) =>
  expect.objectContaining({ data: expect.objectContaining({ code: "INVALID_IMAGE", hint }) });

it.each([
  ["a PNG", PNG, "image/png", 2, 3],
  ["a baseline JPEG", jpeg(0xc0), "image/jpeg", 9, 7],
  ["a progressive JPEG", jpeg(0xc2), "image/jpeg", 9, 7],
  ["a GIF", GIF, "image/gif", 4, 5],
])("reads %s's type and pixel size from its bytes", (_, bytes, mime, width, height) => {
  expect(readImage(url(bytes, "image/x-anything"), "src")).toMatchObject({ mime, width, height });
});

it("reads the valid fixture PNG", () => {
  expect(readImage(RED_2x2_PNG, "src")).toMatchObject({ mime: "image/png", width: 2, height: 2 });
});

it("reads a percent-encoded data URL as the same bytes", () => {
  const encoded = `data:image/gif,${[...GIF].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("")}`;
  expect(readImage(encoded, "src").bytes).toEqual(new Uint8Array(GIF));
});

// The Worker converts a WebP before anything stores it (ADR-0100); one reaching here was not.
it.each([WEBP_LOSSY_4x3, WEBP_LOSSLESS_4x3])("never takes a WebP as it is: %#", (src) => {
  expect(() => readImage(src, "src")).toThrow(
    expect.objectContaining({
      data: expect.objectContaining({
        code: "INVALID_IMAGE",
        message: expect.stringContaining("no Kalamo file holds"),
        hint: expect.not.stringContaining("onvert it"),
      }),
    }),
  );
});

it.each([
  ["text", "data:text/plain,hi"],
  ["a URL", "https://example.com/a.png"],
  ["broken base64", "data:image/png;base64,***"],
  ["a truncated PNG", url(PNG.slice(0, 20))],
  [
    "a PNG whose first chunk is not IHDR",
    url([...SIGNATURE, ...u32be(13), 73, 68, 65, 84, ...u32be(2), ...u32be(3)]),
  ],
])("refuses %s", (_, src) => {
  expect(() => readImage(src, "src")).toThrow(invalid());
});

it("caps a file at 5 MB", () => {
  const big = new Uint8Array(MAX_IMAGE_BYTES);
  big.set(PNG);
  expect(readImage(url(big), "src").bytes.length).toBe(MAX_IMAGE_BYTES);
  const over = new Uint8Array(MAX_IMAGE_BYTES + 1);
  over.set(PNG);
  expect(() => readImage(url(over), "nodes[0].src")).toThrow(
    expect.objectContaining({
      data: expect.objectContaining({ code: "LIMIT_EXCEEDED", path: "nodes[0].src" }),
    }),
  );
});

it("checks raw bytes as it checks a data URL's, for a fetched file", () => {
  expect(checkImage(new Uint8Array(PNG), "src")).toMatchObject({ mime: "image/png", width: 2 });
  expect(() => checkImage(new Uint8Array(GIF.slice(0, 3)), "src")).toThrow(invalid());
  const over = new Uint8Array(MAX_IMAGE_BYTES + 1);
  over.set(PNG);
  expect(() => checkImage(over, "src")).toThrow(
    expect.objectContaining({ data: expect.objectContaining({ code: "LIMIT_EXCEEDED" }) }),
  );
});

it("names a file by its SHA-256", async () => {
  expect(await imageId(new Uint8Array())).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

it("writes a file back as the data URL it was read from", () => {
  expect(dataUrl(readImage(url(PNG, "image/jpeg"), "src"))).toBe(url(PNG));
});

it.each([
  ["none", "none"],
  ["xMidYMid", "xMidYMid meet"],
  ["  xMinYMax   slice ", "xMinYMax slice"],
  ["defer xMaxYMin meet", "xMaxYMin meet"],
  ["stretch", undefined],
  ["xMidYMid cover", undefined],
])("spells preserveAspectRatio %j as %j", (value, stored) => {
  expect(preserveAspectRatio(value)).toBe(stored);
});

it.each([
  ["none", { x: 10, y: 10, width: 60, height: 40 }],
  ["xMidYMid meet", { x: 10, y: 20, width: 60, height: 20 }],
  ["xMaxYMin meet", { x: 10, y: 10, width: 60, height: 20 }],
  ["xMinYMax slice", { x: 10, y: 10, width: 120, height: 40 }],
  ["xMidYMid slice", { x: -20, y: 10, width: 120, height: 40 }],
])("places a 30 × 10 file in a 60 × 40 frame at (10, 10) under %s", (par, rect) => {
  expect(
    aspectPlacement({ x: 10, y: 10, width: 60, height: 40 }, { width: 30, height: 10 }, par),
  ).toEqual(rect);
});

const ORIENTATIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const jpegFile = (bytes: Uint8Array<ArrayBuffer>) =>
  ({ mime: "image/jpeg", width: 8, height: 4, bytes }) as const;
// In orientedJpeg's files: APP1 at 2, TIFF at 12, Orientation's entry at 34, its value at 42, and
// the block's end at 50.
const VALUE = 42;
const APP1_END = 50;

describe("neutraliseOrientation (ADR-0101)", () => {
  it.each(ORIENTATIONS)("rewrites orientation %i to 1 and changes nothing else", (o) => {
    const file = readImage(orientedJpeg(o), "src");
    const out = neutraliseOrientation(file);
    expect(out.orientation).toBe(o);
    expect(out.file.bytes.length).toBe(file.bytes.length);
    const changed = [...out.file.bytes.keys()].filter((i) => out.file.bytes[i] !== file.bytes[i]);
    expect(changed).toEqual(o === 1 ? [] : [VALUE]);
    expect(out.file.bytes[VALUE]).toBe(1);
    expect(neutraliseOrientation(out.file).orientation).toBe(1);
    if (o === 1) expect(out.file).toBe(file);
    else expect(file.bytes[VALUE]).toBe(o);
  });

  it("reads and rewrites a big-endian (MM) value in the second byte", () => {
    const file = readImage(orientedJpeg(6, { bigEndian: true }), "src");
    const out = neutraliseOrientation(file);
    expect(out.orientation).toBe(6);
    expect([...out.file.bytes.subarray(VALUE, VALUE + 2)]).toEqual([0, 1]);
  });

  it("returns a file with no Exif, a PNG and a GIF as they are", () => {
    for (const url of [QUADRANTS_8x4_JPEG, RED_2x2_PNG]) {
      const file = readImage(url, "src");
      expect(neutraliseOrientation(file)).toEqual({ file, orientation: 1 });
    }
    // A PNG's bytes are never read for Exif, whatever they hold.
    const png = { ...readImage(orientedJpeg(6), "src"), mime: "image/png" as const };
    expect(neutraliseOrientation(png).orientation).toBe(1);
  });

  const six = () => readImage(orientedJpeg(6), "src").bytes;
  const edit = (f: (b: Uint8Array, v: DataView) => void) => {
    const b = six();
    f(b, new DataView(b.buffer));
    return b;
  };
  it.each([
    ["IFD0 past the block", orientedJpeg(6, { ifd0: 1000 })],
    ["IFD0 at the block's last byte", orientedJpeg(6, { ifd0: APP1_END - 12 - 1 })],
    ["a bad byte order", edit((b) => b.set([0x49, 0x4d], 12))],
    ["a bad magic number", edit((_, v) => v.setUint16(14, 43, true))],
    ["the value a LONG", edit((_, v) => v.setUint16(36, 4, true))],
    ["a count of 2", edit((_, v) => v.setUint32(38, 2, true))],
    ["a value of 0", edit((_, v) => v.setUint16(VALUE, 0, true))],
    ["a value of 9", edit((_, v) => v.setUint16(VALUE, 9, true))],
    ["the value in the field's second byte", edit((_, v) => v.setUint16(VALUE, 6 << 8, true))],
    [
      "no 0x0112 entry, and an entry count of 65535",
      edit((_, v) => {
        v.setUint16(34, 0x0113, true);
        v.setUint16(20, 0xffff, true);
      }),
    ],
    ["the APP1 length past the file", edit((_, v) => v.setUint16(4, 0xfff0))],
    ["the APP1 length under 2", edit((_, v) => v.setUint16(4, 1))],
    ["no Exif\\0\\0", edit((b) => b.set([0x45, 0x78, 0x69, 0x66, 0, 1], 6))],
    [
      "the Exif after the SOS",
      (() => {
        const b = six();
        return new Uint8Array([...b.subarray(0, 2), 0xff, 0xda, 0, 2, ...b.subarray(2)]);
      })(),
    ],
    [
      "the Exif after the EOI",
      (() => {
        const b = six();
        return new Uint8Array([...b.subarray(0, 2), 0xff, 0xd9, ...b.subarray(2)]);
      })(),
    ],
  ])("treats %s as orientation 1 and keeps the bytes", (_, input) => {
    const bytes = typeof input === "string" ? readImage(input, "src").bytes : input;
    const before = bytes.slice();
    const out = neutraliseOrientation(jpegFile(bytes));
    expect(out.orientation).toBe(1);
    expect(out.file.bytes).toBe(bytes);
    expect(bytes).toEqual(before);
  });

  it("skips an APP1 that is not Exif, and fill bytes, to the Exif block", () => {
    const b = six();
    const xmp = [0xff, 0xff, 0xe1, 0, 6, 0x68, 0x74, 0x74, 0x70];
    const bytes = new Uint8Array([...b.subarray(0, 2), ...xmp, ...b.subarray(2)]);
    expect(neutraliseOrientation(jpegFile(bytes)).orientation).toBe(6);
  });

  it("never throws on a truncation, and reads 1 unless the Exif block is whole", () => {
    const fixtures = [
      ...ORIENTATIONS.map((o) => [orientedJpeg(o), o] as const),
      [orientedJpeg(6, { bigEndian: true }), 6] as const,
      [orientedJpeg(6, { ifd0: 1000 }), 1] as const,
    ];
    for (const [url, o] of fixtures) {
      const bytes = readImage(url, "src").bytes;
      for (let n = 0; n <= bytes.length; n++) {
        const cut = bytes.slice(0, n);
        const out = neutraliseOrientation(jpegFile(cut));
        expect(out.orientation).toBe(n >= APP1_END ? o : 1);
        if (n < APP1_END) expect(out.file.bytes).toBe(cut);
      }
    }
  });

  it("never throws on any byte of the Exif block set to 0x00 or 0xff", () => {
    for (let i = 2; i < APP1_END; i++) {
      for (const x of [0, 0xff]) {
        const b = edit((b) => b.set([x], i));
        const out = neutraliseOrientation(jpegFile(b));
        expect([1, 6]).toContain(out.orientation);
        if (out.orientation === 1) expect(out.file.bytes).toBe(b);
      }
    }
  });
});

describe("orientImage (ADR-0101)", () => {
  // The upright box: 40 wide, 20 high, centred on (30, 30).
  const box = { x: 10, y: 20, width: 40, height: 20 };
  it.each([
    [1, { x: 10, y: 20, width: 40, height: 20 }, [1, 0, 0, 1, 0, 0]],
    [2, { x: 10, y: 20, width: 40, height: 20 }, [-1, 0, 0, 1, 60, 0]],
    [3, { x: 10, y: 20, width: 40, height: 20 }, [-1, 0, 0, -1, 60, 60]],
    [4, { x: 10, y: 20, width: 40, height: 20 }, [1, 0, 0, -1, 0, 60]],
    [5, { x: 20, y: 10, width: 20, height: 40 }, [0, 1, 1, 0, 0, 0]],
    [6, { x: 20, y: 10, width: 20, height: 40 }, [0, 1, -1, 0, 60, 0]],
    [7, { x: 20, y: 10, width: 20, height: 40 }, [0, -1, -1, 0, 60, 60]],
    [8, { x: 20, y: 10, width: 20, height: 40 }, [0, -1, 1, 0, 0, 60]],
  ] as const)("orientation %i: frame %o, matrix %o", (o, frame, matrix) => {
    const turned = orientImage(box, o, "none");
    expect(turned.frame).toEqual(frame);
    expect(turned.matrix).toEqual(matrix);
    expect(turned.preserveAspectRatio).toBe("none");
  });

  it.each(ORIENTATIONS)(
    "orientation %i puts each stored corner where the upright photo has it",
    (o) => {
      const { frame, matrix } = orientImage(box, o, "none");
      // The stored file's corners hold R, G, B and Y; UPRIGHT_QUADRANTS lists the upright ones.
      const stored = [
        ["R", frame.x, frame.y],
        ["G", frame.x + frame.width, frame.y],
        ["B", frame.x, frame.y + frame.height],
        ["Y", frame.x + frame.width, frame.y + frame.height],
      ] as const;
      const corners = [
        [box.x, box.y],
        [box.x + box.width, box.y],
        [box.x, box.y + box.height],
        [box.x + box.width, box.y + box.height],
      ];
      const shown = corners.map(([x, y]) => {
        const hit = stored.find(([, u, v]) => {
          const [X, Y] = applyTo(matrix, u, v);
          return X === x && Y === y;
        });
        return hit?.[0];
      });
      expect(shown.join("")).toBe(UPRIGHT_QUADRANTS[o]);
    },
  );

  it.each([
    [1, "xMinYMax"],
    [2, "xMaxYMax"],
    [3, "xMaxYMin"],
    [4, "xMinYMin"],
    [5, "xMaxYMin"],
    [6, "xMaxYMax"],
    [7, "xMinYMax"],
    [8, "xMinYMin"],
  ] as const)("orientation %i maps xMinYMax to %s", (o, align) => {
    expect(orientImage(box, o, "xMinYMax slice").preserveAspectRatio).toBe(`${align} slice`);
  });

  it("puts the pixels where the upright alignment does, for every orientation and alignment", () => {
    const file = { width: 8, height: 4 };
    for (const o of ORIENTATIONS as readonly Orientation[]) {
      for (const x of ["Min", "Mid", "Max"]) {
        for (const y of ["Min", "Mid", "Max"]) {
          for (const how of ["meet", "slice"]) {
            const fit = `x${x}Y${y} ${how}`;
            const turned = orientImage(box, o, fit);
            const p = aspectPlacement(turned.frame, file, turned.preserveAspectRatio);
            const [x0, y0] = applyTo(turned.matrix, p.x, p.y);
            const [x1, y1] = applyTo(turned.matrix, p.x + p.width, p.y + p.height);
            const shown = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
            const want = aspectPlacement(box, o >= 5 ? { width: 4, height: 8 } : file, fit);
            expect({ o, fit, ...shown }).toEqual({ o, fit, x: want.x, y: want.y });
          }
        }
      }
    }
  });
});

describe("inverseOrientation (ADR-0102)", () => {
  it("undoes orientedImage exactly, whatever the alignment and the transform on top", () => {
    const box = { x: 10, y: 20, width: 30, height: 40 };
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      for (const preserveAspectRatio of ["none", "xMinYMax meet", "xMaxYMin slice"]) {
        const image = { ...box, preserveAspectRatio, transform: [0, 2, -1, 0, 50, 5] as Matrix };
        expect(orientedImage(orientedImage(image, o), inverseOrientation(o))).toEqual(image);
      }
    }
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((o) => inverseOrientation(o as Orientation))).toEqual([
      1, 2, 3, 4, 5, 8, 7, 6,
    ]);
  });
});
