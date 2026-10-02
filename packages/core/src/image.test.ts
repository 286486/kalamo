import { expect, it } from "vitest";
import { RED_2x2_PNG, WEBP_HEADER } from "../../../fixtures/images.ts";
import {
  aspectPlacement,
  checkImage,
  dataUrl,
  imageId,
  MAX_IMAGE_BYTES,
  preserveAspectRatio,
  readImage,
} from "./image.ts";

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

it("refuses WebP with a hint to convert it to PNG", () => {
  expect(() => readImage(WEBP_HEADER, "src")).toThrow(invalid(expect.stringContaining("PNG")));
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
