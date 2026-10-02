import { exports } from "cloudflare:workers";
import { imageId } from "@kalamo/core";
import { expect } from "vitest";
import { decodePng } from "../../../fixtures/png.ts";

/** The RGBA of the file the image route serves for `src`: a PNG hashed to `src` (ADR-0100). */
export async function servedPng(docId: string, src: string) {
  const res = await exports.default.fetch(`http://kalamo/api/docs/${docId}/images/${src}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(await imageId(bytes)).toBe(src);
  return [...(await decodePng(bytes)).data];
}
