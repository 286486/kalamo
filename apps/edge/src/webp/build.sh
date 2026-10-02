#!/bin/sh
# Builds webp.wasm, libwebp's decoder alone as a standalone wasm with no Emscripten JS (ADR-0100).
# Needs Docker and the network; run it from any directory. CI does not run it.
set -eu
cd "$(dirname "$0")"

VERSION=1.6.0
TARBALL_SHA256=e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564
EMSDK=emscripten/emsdk:6.0.10@sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65
# The most memory one decode may take: what the 4096 x 2048 cap fixtures need, plus a margin.
MAXIMUM_MEMORY=${MAXIMUM_MEMORY:-83886080}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -sSfL "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-$VERSION.tar.gz" -o "$work/libwebp.tar.gz"
echo "$TARBALL_SHA256  $work/libwebp.tar.gz" | sha256sum -c -
tar -xzf "$work/libwebp.tar.gz" -C "$work"

docker run --rm -u "$(id -u):$(id -g)" -v "$work:/work" -w /work "$EMSDK" sh -euc "
  emcmake cmake -S libwebp-$VERSION -B build -DCMAKE_BUILD_TYPE=Release \
    -DWEBP_ENABLE_SIMD=OFF -DWEBP_USE_THREAD=OFF -DWEBP_BUILD_ANIM_UTILS=OFF \
    -DWEBP_BUILD_CWEBP=OFF -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF \
    -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF -DWEBP_BUILD_WEBPINFO=OFF \
    -DWEBP_BUILD_WEBPMUX=OFF -DWEBP_BUILD_EXTRAS=OFF -DWEBP_BUILD_LIBWEBPMUX=OFF
  emmake make -C build webpdecoder
  emcc -O3 build/libwebpdecoder.a -o webp.wasm -sSTANDALONE_WASM --no-entry \
    -sEXPORTED_FUNCTIONS=_malloc,_free,_WebPDecodeRGBAInto,_WebPGetDecoderVersion \
    -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=$MAXIMUM_MEMORY -sFILESYSTEM=0
"
cp "$work/webp.wasm" webp.wasm
cp "$work/libwebp-$VERSION/COPYING" COPYING
cp "$work/libwebp-$VERSION/PATENTS" PATENTS
sha256sum webp.wasm
