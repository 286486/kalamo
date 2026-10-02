---
status: accepted
date: 2026-10-02
---

# WebP is converted to PNG on the way in

F-IO-02 lists WebP among the formats Place takes, and Illustrator has opened and placed WebP since 26.0 (2022). ADR-0023 refused it, because neither renderer that draws a stored Image could draw it: a stored WebP would have been invisible in `render` and in Inkscape. ADR-0027 and ADR-0098 kept that refusal for `image_place` and for Open. This ADR accepts WebP at every entry that takes an image file. The Worker decodes the file and stores a lossless PNG of the same pixels. Illustrator also keeps an embedded image's pixels rather than its file: Unembed writes a PSD or TIFF, not the original. It implements #250, part A of #59.

## Survey (2026-10-02)

- **resvg.** Every `@resvg/resvg-wasm` release up to 2.7.0-alpha.2 (2026-01) still wraps resvg 0.34. resvg added WebP decoding in 0.43 (2024-08). No maintained wasm build of a newer resvg with raster images exists.
- **Inkscape.** No release has its own WebP decoder. It draws WebP only when the separate `webp-pixbuf-loader` is installed. That loader is not on the dev machine, and ubuntu-24.04 CI does not install it.
- **Workers.** The runtime has no `ImageDecoder`, `createImageBitmap` or `OffscreenCanvas`. It has `CompressionStream("deflate")`. Wasm can only be instantiated from a module compiled at deploy time (ADR-0034).

Waiting for the renderers has no date, so Kalamo converts.

## Decision

1. **Every entry converts.** `node_create` image `src` (inline `children` included), `node_update` `src`, `kalamo_image_place` (URL and data URL), the browser's Place, paste and drop (`place-image`), Relink (`relink-image`), Open (`POST /api/docs` and `kalamo_doc_open`), and every WebP `<image>` data URL in an SVG read by `doc_open`, `POST /api/docs`, `svg_import` and the browser's SVG Place and paste. After the conversion the file is an ordinary PNG Image. Its `src` is the PNG's SHA-256. The receipt, `node_get` and the image route report `image/png`. `render`, the canvas, `export` and Inkscape 1.2.2 all draw the same pixels.
2. **Stored bytes are never WebP.** `ImageInfo.mime` stays PNG, JPEG or GIF. `checkImage` still refuses raw WebP, as an internal guard. Its message now says that Kalamo converts WebP on the way in, so a WebP that reaches it, such as a `.kalamo.json` `images` entry (still `INVALID_DOCUMENT`) or a `src` sent over the browser WebSocket, is not a Kalamo file's image.
3. **Recognised by bytes.** A WebP is `RIFF....WEBP`, never a MIME type, `Content-Type` or extension (ADR-0023). The first chunk gives the pixel size before anything is decoded: VP8 14-bit width and height at 26 and 28; VP8L 14-bit `width-1` and `height-1` in the u32 at 21; VP8X 24-bit `width-1` and `height-1` at 24 and 27, and the animation flag (bit `0x02` of byte 20).
4. **The checks, in order**, each with its own message:
   1. The incoming file is at most 5 MB, else `LIMIT_EXCEEDED` as before.
   2. An animated WebP fails `INVALID_IMAGE` with the hint "Export one frame as PNG or GIF". A GIF places its first frame, so this is a known gap, accepted because libwebp's simple decoder refuses animation and the flag makes the message exact.
   3. A header over **8,388,608 pixels (8 MiP, 4096 × 2048)** fails `LIMIT_EXCEEDED`, naming width × height and the cap. Nothing is decoded.
   4. A file libwebp cannot decode fails `INVALID_IMAGE` ("damaged").
   5. The PNG is encoded.
   6. The PNG passes `checkImage`. A PNG over 5 MB fails `LIMIT_EXCEEDED` with "The WebP was converted to a PNG of N bytes; the limit is 5242880 (5 MB)" and the hint to scale it down or place a JPEG.
   7. The Document's 20 MB (ADR-0046) and the owner's 200 MB (ADR-0048) count the PNG, since both count stored bytes. No quota code changed.

   On the SVG paths a refused WebP is dropped with an `INVALID_IMAGE` warning carrying that message, as any refused `<image>` is.
5. **In the Worker, before the Document Durable Object.** Decoding never holds a Document's input gate (ADR-0027's reasoning), and the Durable Object never decodes or stores WebP. `normaliseImage(bytes, path)` in `apps/edge/src/normalise-image.ts` returns an `ImageFile`. Non-WebP bytes go to `checkImage` unchanged. `fetchImage`, the `bitmap()` body reader and `openedContent` call it. `service.ts`'s `parse`, which Open and Place share, converts a bitmap data URL before `parseFile`, and converts each WebP among an SVG's `<image>` data URLs (`embeddedImages` in io finds them as the parsed attribute holds them). `parseFile` takes the results as `converted`, which the synchronous reader consults before `readImage`. `createNodes` and `updateNodes` walk the inputs and replace a WebP `src` with its PNG's data URL. A WebP they cannot convert keeps its `src`, and its error goes to the Durable Object in `refusedImages` under the path it would report. The Durable Object then fails that item as it fails any other refused file, so `partial` and the item's `index` and `path` behave as before. `core`, `io` and `apps/web` import no decoder and no `.wasm`. The web build is bundled from core and io, and `pnpm check:bundle` fails if `WebPDecode` reaches its assets.
6. **The decoder: libwebp v1.6.0, built by Kalamo.** `apps/edge/src/webp/build.sh` builds `webp.wasm`, libwebp's `webpdecoder` library alone, with no Emscripten JS glue: `-sSTANDALONE_WASM --no-entry`, no threads, no SIMD, no filesystem. It exports only `malloc`, `free`, `WebPDecodeRGBAInto` and `WebPGetDecoderVersion`, and imports only `emscripten_notify_memory_growth`. Memory may grow up to `-sMAXIMUM_MEMORY=83886080` (80 MiB, see decision 8), so a hostile file cannot take more.
   - Release tarball `libwebp-1.6.0.tar.gz`, SHA-256 `e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564` (it matches Homebrew's formula).
   - Build image `emscripten/emsdk:6.0.10@sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65`.
   - `webp.wasm` is 127,862 bytes, SHA-256 `ac3563de4a42641a8392f9d01fb2309c56f03f31978d654aca2ef01b3c34e4fc`. Two runs of the script gave the same file.
   - A test asserts `WebPGetDecoderVersion()` is `0x010600`. CI does not rebuild. Rerunning the script reproduces the file.
   - libwebp is BSD-3-Clause, "Copyright (c) 2010, Google Inc. All rights reserved.". Its `COPYING` and `PATENTS` are committed beside the wasm, and NOTICE lists it.
7. **Loaded per ADR-0034, one instance per file.** The `.wasm` is a static import, which wrangler compiles at deploy as it does pathkit's and resvg's. Each conversion makes a fresh `WebAssembly.Instance` and drops it afterwards. Wasm memory never shrinks, so one instance per isolate would keep its high-water mark for the isolate's life. A fresh one also means that a damaged file leaves no state for the next request. Instantiating a compiled module is cheap.
8. **Memory at the cap.** The decoder writes RGBA into its own memory, and the encoder reads rows from it directly, so there is no JS copy of the pixels. The decoder's memory after decoding 4096 × 2048 files (Node 24, the same wasm):

   | File | Bytes | Wasm memory |
   |---|---|---|
   | lossy, one colour (`WEBP_CAP_LOSSY`) | 14,998 | 34,209,792 |
   | lossless, one colour (`WEBP_CAP_LOSSLESS`) | 396 | 38,141,952 |
   | lossless gradient, no palette | 12,392 | 67,698,688 |
   | lossless noise | 7,640,970 | 75,235,328 |
   | lossy `-q 100` noise | 3,711,300 | 56,688,640 |

   Lossless needs about two full planes: libwebp's ARGB buffer beside the RGBA output. The noise file is over the 5 MB input cap, so it is a bound that no accepted file reaches. The cap is 80 MiB (83,886,080 bytes), about 8 MB over that bound. With pathkit's 32 MiB heap resident, wasm takes at most 112 MiB of the isolate's 128 MB. The JS side holds the input (≤ 5 MB), one filtered row and the compressed output, whose chunks are dropped once they pass 5 MB. Conversions in one isolate run one at a time, so two never hold 80 MiB each. So the 8 MiP cap stays as #59 set it. A test grows a decoder's memory to the cap and fails one page past it.
9. **The PNG encoder** is Kalamo's own, beside the decoder: IHDR, one IDAT and IEND, with CRC-32, compressed by `CompressionStream("deflate")`, which gives the zlib stream IDAT requires. It is 8-bit RGB when every alpha is 255 and RGBA otherwise, non-interlaced, with Paeth on every row and no adaptive filtering. A lossless WebP's PNG decodes to exactly its RGBA, and a lossy one's to libwebp's pixels (`dwebp -pam`).
10. **Determinism.** Within one deploy, the same WebP gives byte-identical PNGs, so its `src` is stable and a second Place stores nothing new. Encoding runs only in the Worker. A workerd upgrade that changes zlib's output may give the same WebP a different `src` afterwards. That stores a second file once, which is accepted.
11. **Bundle.** `wrangler deploy --dry-run` was 33,405.66 KiB uncompressed (gzip 24,496.46 KiB) at 1a0db4a, and is 33,540.60 KiB (gzip 24,543.00 KiB) with this change. Cloudflare's limit is 64 MiB uncompressed on Free and Paid plans, with no compressed limit.
12. **CPU.** Decoding a 4096 × 2048 file took 15–250 ms in Node 24 on the dev machine, before encoding. A self-host on the Free plan (10 ms CPU per request) may hit its CPU limit on a large WebP. The Paid plan's default is 30 s.

ADR-0023's WebP refusal, ADR-0027's "WebP refused" and ADR-0098's WebP refusal and naming are superseded: a Document opened from `photo.webp` is named `photo`.

## Considered Options

- **Wait for the renderers.** No resvg-wasm with WebP is in sight, and Inkscape would still need a loader that most installs lack (Survey).
- **The Cloudflare Images binding.** It allows 5,000 unique transformations a month free, then bills or fails (error 9422). `vitest-pool-workers` and `wrangler dev` run only a low-fidelity offline version. It would also be a new external dependency for self-hosting.
- **`@jsquash/webp` 1.5.0.** Its decoder is libwebp 1.1.0: `WebPGetDecoderVersion()` returns `0x010100`, and its Makefile pins libwebp `d2e245e` of 2020-11-24. That version has CVE-2023-4863, the VP8L Huffman heap overflow that was exploited in the wild and fixed in libwebp 1.3.2. `kalamo_image_place` decodes bytes from any http(s) URL. The upstream rebuild request, jSquash#112, has no maintainer reply.
- **`wasm-webp` 0.1.0.** It ships libwebp 1.3.2, past the fix, but it has a single maintainer, so a future libwebp fix would wait on one person. Building from libwebp's release keeps the upgrade in Kalamo's hands.
- **A pure-TypeScript decoder.** Kalamo would own a large parser of hostile input, without the fuzzing libwebp gets upstream.
- **JPEG for lossy WebP, to save bytes.** It needs a second codec, a JPEG encoder, and loses quality a second time. A PNG over 5 MB fails with a message that names the conversion. Revisit if users hit the limit.
- **Storing WebP as WebP.** Nothing downstream draws it (Survey).
- **One decoder instance per isolate.** It would keep up to 80 MiB beside pathkit for the isolate's life and share state between requests (decision 7).
- **Decoding in the Document Durable Object.** It would hold the Document's input gate for the whole decode, as a fetch would (ADR-0027).
