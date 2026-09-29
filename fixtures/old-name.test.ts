// The old-name guard (#172, ADR-0069): every case-insensitive hit of the former name left in a
// tracked file's content or path needs an allowlist entry that says why it stays and which rename
// ticket removes it. A ticket that removes the last hit of an entry deletes the entry; when the
// rename is done the allowlist is empty. The name comes from its one source, built from parts.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LEGACY_NAME as OLD } from "../packages/core/src/legacy.ts";

const Old = OLD[0]?.toUpperCase() + OLD.slice(1);
const hit = new RegExp(OLD, "i");

type Entry = {
  /** Files the entry covers; every file when absent. */
  path?: RegExp;
  /** The hits it covers in those files; every hit when absent. */
  token?: RegExp;
  reason: string;
  /** The rename ticket that removes the entry, or `permanent`. */
  until: `#${number}` | "permanent";
};

const ALLOWLIST: Entry[] = [
  {
    path: /^apps\/edge\/wrangler\.jsonc$/,
    reason: "Cloudflare resource names: Worker, D1 database and R2 bucket.",
    until: "#180",
  },
];

type Hit = { path: string; line?: number; text: string };

/** The hits no entry covers, and the entries that covered nothing. */
function check(hits: Hit[], allowlist: Entry[]) {
  const used = new Set<Entry>();
  const uncovered = hits.filter(({ path, text }) => {
    let rest = text;
    for (const entry of allowlist) {
      if (entry.path && !entry.path.test(path)) continue;
      const next = entry.token ? rest.replace(entry.token, "\u0000") : "";
      if (next !== rest) used.add(entry);
      rest = next;
      if (!hit.test(rest)) return false;
    }
    return true;
  });
  return { uncovered, unused: allowlist.filter((e) => !used.has(e)) };
}

function trackedHits(): Hit[] {
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
  const lines = (s: string) => s.split("\n").filter(Boolean);
  const inContent = lines(git("grep", "-I", "-i", "-n", OLD, "--", ".")).map((l) => {
    const [, path = "", line, text = ""] = l.match(/^(.+?):(\d+):(.*)$/) ?? [];
    return { path, text, line: Number(line) };
  });
  const inPaths = lines(git("ls-files")).filter((p) => hit.test(p));
  return [...inContent, ...inPaths.map((path) => ({ path, text: path }))];
}

describe("the old name", () => {
  it("appears in tracked files only where an allowlist entry says why", () => {
    const { uncovered, unused } = check(trackedHits(), ALLOWLIST);
    expect(uncovered).toEqual([]);
    expect(unused.map((e) => e.reason)).toEqual([]);
  });

  it("fails on a new hit outside the allowlist, in content or in a path", () => {
    const { uncovered } = check(
      [
        { path: "packages/core/src/x.ts", text: `export class ${Old}Thing {}` },
        { path: `packages/core/src/${OLD}.ts`, text: `packages/core/src/${OLD}.ts` },
        { path: "docs/adr/0001-x.md", text: `The ${Old} Authors.` },
        { path: "apps/edge/wrangler.jsonc", text: `"name": "${OLD}",` },
      ],
      ALLOWLIST,
    );
    expect(uncovered.map((h) => h.text)).toEqual([
      `export class ${Old}Thing {}`,
      `packages/core/src/${OLD}.ts`,
      `The ${Old} Authors.`,
    ]);
  });

  it("covers a hit only in the files and tokens its entry names", () => {
    const token = new RegExp(`${OLD}_\\w+`, "g");
    const entry: Entry = { path: /^a\.ts$/, token, reason: "r", until: "#175" };
    const { uncovered, unused } = check(
      [
        { path: "a.ts", text: `${OLD}_export and ${Old}` },
        { path: "b.ts", text: `${OLD}_export` },
      ],
      [entry, { path: /^never$/, reason: "stale", until: "#177" }],
    );
    expect(uncovered.map((h) => h.path)).toEqual(["a.ts", "b.ts"]);
    expect(unused.map((e) => e.reason)).toEqual(["stale"]);
  });
});
