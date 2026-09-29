import { env } from "cloudflare:workers";
import { readImage } from "@kalamo/core";
import { expect } from "vitest";
import { RED_2x2_PNG } from "../../../fixtures/images.ts";

export const MiB = 1024 * 1024;

/** `count` chunks of `size` bytes, pulled one at a time; `pulls` says how many were. */
export function counted(count: number, size = MiB) {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (pulls === count) return c.close();
        pulls++;
        c.enqueue(new Uint8Array(size));
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls };
}

/** The `.kalamo.json` of a Document whose images fill the 20 MB cap (ADR-0046), over 26 MiB. */
export async function fullKalamoFile(docId: string, layerId: string) {
  const s = env.DOCUMENT.get(env.DOCUMENT.idFromName(docId));
  const red = readImage(RED_2x2_PNG, "src").bytes;
  for (let n = 0; n < 4; n++) {
    const bytes = new Uint8Array(5 * MiB);
    bytes.set(red);
    bytes[bytes.length - 1] = n;
    const src = `data:image/png;base64,${bytes.toBase64()}`;
    const created = await s.createNodes(
      [{ type: "image", parentId: layerId, src, x: n, y: 0 }],
      "agent",
    );
    expect(created).not.toHaveProperty("error");
  }
  const file = await s.file("agent");
  if ("error" in file) throw new Error(file.error.message);
  expect(file.text.length).toBeGreaterThan(26 * MiB);
  return file.text;
}
