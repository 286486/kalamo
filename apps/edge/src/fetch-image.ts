import { checkImage, type ImageFile, KalamoError, readImage } from "@kalamo/core";
import { readCapped } from "./body.ts";

/** §7.5's cap on what is read; the stored file stays capped at 5 MB (ADR-0027). */
const MAX_FETCH_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

const notAUrl = () =>
  new KalamoError({
    code: "INVALID_IMAGE",
    message: "src is not an http or https URL, or a data: URL.",
    hint: "The server cannot read your disk: read the file and send it as a data: URL, or give a public http(s) URL.",
    path: "src",
  });
const tooLarge = () =>
  new KalamoError({
    code: "LIMIT_EXCEEDED",
    message: "The file is over 20 MB, the most the server reads.",
    hint: "Place an image of at most 5 MB: scale it down or compress it first.",
    path: "src",
  });
const failed = (message: string) =>
  new KalamoError({
    code: "FETCH_FAILED",
    message,
    hint: "Give a public http(s) URL that answers with the file itself, or send the file as a data: URL.",
    path: "src",
  });

/**
 * `image_place`'s `src` as a checked file and the name a Template Layer takes (ADR-0027). A URL is
 * fetched here, redirects followed by hand so every hop passes `refusedHost`.
 */
export async function fetchImage(src: string): Promise<ImageFile & { name: string }> {
  if (src.startsWith("data:")) return { ...readImage(src, "src"), name: "Image" };
  let url = httpUrl(src);
  if (!url) throw notAUrl();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    for (let hops = 0; ; hops++) {
      // ponytail: a DNS name resolving to a private address passes; the platform network refuses it.
      if (refusedHost(url.hostname)) {
        throw failed(
          `${url.hostname} is a local or private address, which the server never fetches.`,
        );
      }
      const res = await fetch(url.href, { redirect: "manual", signal });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location !== null) {
        await res.body?.cancel();
        if (hops === MAX_REDIRECTS) throw failed(`More than ${MAX_REDIRECTS} redirects.`);
        url = httpUrl(location, url) ?? failedRedirect(location);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw failed(`${url.href} answered ${res.status} ${res.statusText}`.trim());
      }
      if (!res.body) throw failed(`${url.href} answered ${res.status} with no body.`);
      const bytes = await readCapped(res, MAX_FETCH_BYTES, tooLarge);
      return { ...checkImage(bytes, "src"), name: fileName(url) };
    }
  } catch (e) {
    if (e instanceof KalamoError) throw e;
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw failed(`Fetching the file took longer than ${TIMEOUT_MS / 1000} s.`);
    }
    throw failed(`Fetching the file failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function httpUrl(text: string, base?: URL): URL | undefined {
  const url = URL.parse(text, base?.href);
  return url && (url.protocol === "http:" || url.protocol === "https:") ? url : undefined;
}

function failedRedirect(location: string): never {
  throw failed(`A redirect led to ${location}, which is not an http or https URL.`);
}

/** The URL's last path segment, decoded, else its host. */
function fileName(url: URL): string {
  const last = url.pathname.split("/").findLast((s) => s !== "");
  if (!last) return url.hostname;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** IPv4 ranges the server never fetches: [first address, prefix length]. */
const REFUSED_V4: [number, number][] = [
  [0x00000000, 8], // this network
  [0x0a000000, 8], // private
  [0x64400000, 10], // carrier-grade NAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local, cloud metadata
  [0xac100000, 12], // private
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0a80000, 16], // private
  [0xc6120000, 15], // benchmarking
  [0xe0000000, 3], // multicast, reserved, broadcast
];

const refusedV4 = (n: number) =>
  REFUSED_V4.some(([base, bits]) => (n ^ base) >>> (32 - bits) === 0);

/**
 * Whether `hostname`, as the WHATWG URL parser leaves it, is localhost or an IP literal in a
 * loopback, private, link-local, CGNAT, benchmarking, multicast, reserved or unspecified range,
 * IPv4 inside IPv6 included (ADR-0027).
 */
export function refusedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = host.split(".");
  if (v4.length === 4 && v4.every((p) => /^\d+$/.test(p))) {
    return refusedV4(v4.reduce((n, p) => n * 256 + Number(p), 0));
  }
  if (!host.startsWith("[")) return false;
  const [head = "", tail] = host.slice(1, -1).split("::");
  const parts = (s: string) => (s ? s.split(":").map((h) => parseInt(h, 16)) : []);
  const left = parts(head);
  const right = tail === undefined ? [] : parts(tail);
  const h = [...left, ...Array(8 - left.length - right.length).fill(0), ...right] as number[];
  const low32 = (h[6] ?? 0) * 0x10000 + (h[7] ?? 0);
  const zero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  const first = h[0] ?? 0;
  if (zero(0, 5) && (h[5] === 0 || h[5] === 0xffff)) return refusedV4(low32); // ::, ::1, mapped
  if (first === 0x64 && h[1] === 0xff9b && zero(2, 6)) return refusedV4(low32); // NAT64
  if (first === 0x2002) return refusedV4((h[1] ?? 0) * 0x10000 + (h[2] ?? 0)); // 6to4
  return (first & 0xfe00) === 0xfc00 || (first & 0xff80) === 0xfe80 || (first & 0xff00) === 0xff00;
}
