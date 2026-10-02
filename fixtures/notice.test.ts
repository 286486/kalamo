// The NOTICE guard (#253): every bundled third-party font or wasm module is named in NOTICE.
// Tracked font and wasm files match by basename; a `.wasm` import in non-test source matches by
// package name (bare specifier) or basename (relative specifier). Any string literal naming a
// `.wasm` counts, so a dynamic import, a side-effect import or a `?init`-style suffix is caught too.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { expect, it } from "vitest";

const notice = readFileSync(new URL("../NOTICE", import.meta.url), "utf8");
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n");

it("NOTICE names every tracked font and wasm file", () => {
  const files = tracked.filter((p) => /\.(ttf|otf|wasm)$/.test(p)).map((p) => basename(p));
  expect(files.length).toBeGreaterThan(0);
  expect(files.filter((f) => !notice.includes(f))).toEqual([]);
});

it("NOTICE names every wasm module that source imports", () => {
  const sources = tracked.filter(
    (p) =>
      /^(packages|apps)\/[^/]+\/src\/.+\.[cm]?[jt]sx?$/.test(p) && !/\.(test\.|d\.ts$)/.test(p),
  );
  const names = sources.flatMap((p) =>
    [...readFileSync(p, "utf8").matchAll(/["']([^"']+\.wasm)(\?\w+)?["']/g)].map(([, s = ""]) =>
      s.startsWith(".") ? basename(s) : (s.match(/^(@[^/]+\/)?[^/]+/)?.[0] ?? s),
    ),
  );
  expect(names.length).toBeGreaterThan(0);
  expect(names.filter((n) => !notice.includes(n))).toEqual([]);
});
