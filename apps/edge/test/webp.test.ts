import { dataUrlBytes, imageId, KalamoError } from "@kalamo/core";
import { describe, expect, it } from "vitest";
import {
  GREY_4x3_JPEG,
  RED_2x2_PNG,
  WEBP_4x3_RGBA,
  WEBP_ALPHA_4x3,
  WEBP_ALPHA_4x3_RGBA,
  WEBP_ANIMATED,
  WEBP_CAP_LOSSLESS,
  WEBP_CAP_LOSSY,
  WEBP_LOSSLESS_4x3,
  WEBP_LOSSY_4x3,
  WEBP_LOSSY_4x3_RGBA,
  WEBP_OVER_CAP,
  WEBP_TRUNCATED,
} from "../../../fixtures/images.ts";
import { decodePng } from "../../../fixtures/png.ts";
import { decoder, encodePng, normaliseImage, webpHeader } from "../src/normalise-image.ts";

const bytes = (url: string) => dataUrlBytes(url, "src");
const convert = (url: string) => normaliseImage(bytes(url), "src");
const refusal = async (url: string) => {
  try {
    await convert(url);
  } catch (e) {
    if (e instanceof KalamoError) return e.data;
    throw e;
  }
  throw new Error("converted");
};
/** The PNG's IHDR colour type: 2 RGB, 6 RGBA. */
const colourType = (png: Uint8Array) => png[25];

it("runs libwebp 1.6.0", () => {
  expect(decoder().WebPGetDecoderVersion()).toBe(0x010600);
});

it("caps a decoder's memory at 80 MiB, so a hostile file cannot take more", () => {
  const { memory } = decoder();
  const pages = memory.buffer.byteLength / 65536;
  expect(() => memory.grow(80 * 16 - pages + 1)).toThrow(RangeError);
  expect(memory.grow(80 * 16 - pages)).toBe(pages);
});

it.each([
  [WEBP_LOSSY_4x3, { width: 4, height: 3, animated: false }],
  [WEBP_LOSSLESS_4x3, { width: 4, height: 3, animated: false }],
  [WEBP_ALPHA_4x3, { width: 4, height: 3, animated: false }],
  [WEBP_ANIMATED, { width: 4, height: 3, animated: true }],
  [WEBP_OVER_CAP, { width: 4096, height: 2049, animated: false }],
  [WEBP_CAP_LOSSY, { width: 4096, height: 2048, animated: false }],
])("reads the size from the header of %#", (url, header) => {
  expect(webpHeader(bytes(url))).toEqual(header);
});

describe("a WebP converts to a PNG", () => {
  it("of a lossless WebP's exact pixels, RGB when opaque", async () => {
    const file = await convert(WEBP_LOSSLESS_4x3);
    expect(file).toMatchObject({ mime: "image/png", width: 4, height: 3 });
    expect(colourType(file.bytes)).toBe(2);
    expect([...(await decodePng(file.bytes)).data]).toEqual(WEBP_4x3_RGBA);
  });

  it("keeping alpha as RGBA", async () => {
    const file = await convert(WEBP_ALPHA_4x3);
    expect(colourType(file.bytes)).toBe(6);
    expect([...(await decodePng(file.bytes)).data]).toEqual(WEBP_ALPHA_4x3_RGBA);
  });

  it("of the pixels libwebp decodes from a lossy WebP", async () => {
    const file = await convert(WEBP_LOSSY_4x3);
    expect([...(await decodePng(file.bytes)).data]).toEqual(WEBP_LOSSY_4x3_RGBA);
  });

  it("of the same bytes every time", async () => {
    const [a, b] = await Promise.all([convert(WEBP_ALPHA_4x3), convert(WEBP_ALPHA_4x3)]);
    expect(a.bytes).toEqual(b.bytes);
    expect((await convert(WEBP_LOSSY_4x3)).bytes).toEqual((await convert(WEBP_LOSSY_4x3)).bytes);
  });

  // The SHA-256 of `dwebp -pam`'s RGBA for each.
  it.each([
    [
      "lossless",
      WEBP_CAP_LOSSLESS,
      "4282aa5648591615a0a2d942c30fc8e8d48fab127e2e785450eeb822db039ca7",
    ],
    ["lossy", WEBP_CAP_LOSSY, "d7f64c628af79babf77bf0f61c680d20f4b27b3cff306b96ed9e125eadc847e1"],
  ])("at the 4096 × 2048 cap, %s, within the decoder's memory", async (_, url, sha256) => {
    const file = await convert(url);
    expect(file).toMatchObject({ mime: "image/png", width: 4096, height: 2048 });
    expect(await imageId(new Uint8Array((await decodePng(file.bytes)).data))).toBe(sha256);
  });
});

it("passes a PNG or JPEG through as it is", async () => {
  for (const url of [RED_2x2_PNG, GREY_4x3_JPEG]) {
    expect((await convert(url)).bytes).toEqual(bytes(url));
  }
});

describe("refuses", () => {
  it("an animated WebP, with the frame hint", async () => {
    expect(await refusal(WEBP_ANIMATED)).toMatchObject({
      code: "INVALID_IMAGE",
      message: expect.stringContaining("animated"),
      hint: expect.stringContaining("one frame as PNG or GIF"),
    });
  });

  it("a WebP over 8 MiP from its header, naming its size", async () => {
    expect(await refusal(WEBP_OVER_CAP)).toMatchObject({
      code: "LIMIT_EXCEEDED",
      message: expect.stringContaining("4096 × 2049 pixels; the limit is 8388608"),
    });
    // A header alone, with nothing to decode, fails on its size rather than as damaged.
    const header = bytes(WEBP_OVER_CAP).slice(0, 30);
    expect(await refusal(`data:image/webp;base64,${header.toBase64()}`)).toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
  });

  it("a damaged WebP", async () => {
    expect(await refusal(WEBP_TRUNCATED)).toMatchObject({
      code: "INVALID_IMAGE",
      message: expect.stringContaining("damaged"),
    });
  });

  it("a WebP over 5 MB as it comes", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(bytes(WEBP_LOSSY_4x3));
    expect(await refusal(`data:image/webp;base64,${big.toBase64()}`)).toMatchObject({
      code: "LIMIT_EXCEEDED",
      message: expect.stringContaining("the limit is 5242880"),
    });
  });

  it("a PNG over 5 MB, naming its size and the conversion", async () => {
    // Noise does not compress: 1200 × 1200 RGBA is 5.76 MB.
    const rgba = new Uint8Array(1200 * 1200 * 4);
    for (let i = 0; i < rgba.length; i += 65536)
      crypto.getRandomValues(rgba.subarray(i, i + 65536));
    await expect(encodePng(rgba, 1200, "src")).rejects.toMatchObject({
      data: {
        code: "LIMIT_EXCEEDED",
        message: expect.stringMatching(
          /^The WebP was converted to a PNG of \d+ bytes; the limit is 5242880 \(5 MB\)\.$/,
        ),
      },
    });
  });
});
