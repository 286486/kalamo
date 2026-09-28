import type { ZibelError } from "@zibel/core";

/** The most any request body is read: the Durable Object RPC limit ADR-0016 names (ADR-0049). */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/**
 * The body's bytes, read no further than `cap` (ADR-0049). A declared `Content-Length` over it is
 * refused unread; otherwise the stream is counted and cancelled at the first chunk past `cap`.
 * `refuse` gets the declared length, when there is one.
 */
export async function readCapped(
  message: Request | Response,
  cap: number,
  refuse: (declared?: number) => ZibelError,
): Promise<Uint8Array<ArrayBuffer>> {
  const header = Number(message.headers.get("content-length") ?? Number.NaN);
  const declared = Number.isSafeInteger(header) && header >= 0 ? header : undefined;
  if (declared !== undefined && declared > cap) {
    await message.body?.cancel();
    throw refuse(declared);
  }
  if (!message.body) return new Uint8Array(0);
  const reader = (message.body as ReadableStream<Uint8Array>).getReader();
  // Sized to the declared length, so a truthful one is read into one buffer with no copy.
  let bytes = new Uint8Array(declared ?? 64 * 1024);
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return length === bytes.length ? bytes : bytes.slice(0, length);
    if (length + value.length > cap) {
      await reader.cancel();
      throw refuse(declared);
    }
    if (length + value.length > bytes.length) {
      const grown = new Uint8Array(
        Math.min(cap, Math.max(2 * bytes.length, length + value.length)),
      );
      grown.set(bytes.subarray(0, length));
      bytes = grown;
    }
    bytes.set(value, length);
    length += value.length;
  }
}
