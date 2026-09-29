// The old-name guard (#172, ADR-0069): the product was Zibel, and every case-insensitive `zibel`
// left in a tracked file's content or path needs an allowlist entry that says why it stays and
// which rename ticket removes it. A ticket that removes the last hit of an entry deletes the entry.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

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
    path: /^fixtures\/old-name\.test\.ts$/,
    reason: "The guard names what it looks for.",
    until: "permanent",
  },
  {
    path: /^docs\/research\/05-name-conflict-check\.md$/,
    reason: "The name check that chose Zibel, kept as history.",
    until: "permanent",
  },
  {
    path: /^docs\/adr\/0069-the-product-is-named-kalamo\.md$/,
    reason: "The rename ADR is about the old name.",
    until: "permanent",
  },
  {
    token: /zibel_\w*/g,
    reason: "MCP tool names, the zibel_json format and the __Host-zibel_* cookies.",
    until: "#175",
  },
  {
    token: /skill:\/\/zibel\/|mcp__zibel/g,
    reason: "MCP resource URIs and the benchmark's MCP permission prefix.",
    until: "#175",
  },
  {
    path: /^(packages\/mcp\/src\/server\.ts|apps\/edge\/test\/mcp\.test\.ts|examples\/claude-code\.mcp\.json|fixtures\/agent-benchmarks\/)/,
    token: /"zibel"|\bzibel(?=: \{ type)|zibel(?=(-bench-| MCP server| tools))/g,
    reason: "The MCP server name, and the benchmark's server entry, prompts and temp prefix.",
    until: "#175",
  },
  {
    token: /zibel\.dev\/ns\/svg|xmlns:zibel|zibel:(?=[a-z]|\$\{|<name>)/g,
    reason:
      "The SVG namespace and prefix export writes; OAuth scopes zibel:read/write; storage keys zibel:tabs/pencil.",
    until: "#175",
  },
  {
    token: /\.zibel\.json|\.zibel\\\.json|zibel\\\.json/g,
    reason: "The saved file name <doc>.zibel.json.",
    until: "#175",
  },
  {
    path: /^fixtures\/documents\//,
    reason:
      "Fixture Documents and their SVG snapshots carry the old namespace, text and file names.",
    until: "#175",
  },
  {
    token: /x-zibel-|"user-agent": "zibel"/g,
    reason: "Internal Worker-to-DO headers and the GitHub API user agent.",
    until: "#175",
  },
  {
    token: /migrations apply zibel\b/g,
    reason: "Package scripts name the D1 database; they will use the DB binding.",
    until: "#175",
  },
  {
    path: /^(apps\/edge\/src\/(auth|oauth|roles|service)\.ts|apps\/edge\/test\/roles\.test\.ts|apps\/web\/index\.html|apps\/web\/src\/Viewer\.tsx|packages\/core\/src\/file\.ts|packages\/io\/src\/(index|read)\.ts|packages\/mcp\/src\/server\.ts)$/,
    token: /\bZibel\b/g,
    reason:
      "User-visible strings: page titles, the consent page, error messages, hints and tool descriptions.",
    until: "#175",
  },
  {
    path: /^packages\/mcp\/src\/drawing-conventions\.md$/,
    reason: "The drawing conventions the MCP server serves as a resource.",
    until: "#175",
  },
  {
    token: /286486\/zibel/g,
    reason: "Links to the GitHub repository, which moves to 286486/kalamo.",
    until: "#176",
  },
  {
    path: /^(docs\/|README\.md$|CONTEXT\.md$|CLAUDE\.md$|NOTICE$|apps\/edge\/\.deploy\.vars\.example$)/,
    reason: "Docs, ADRs, research notes and the deploy example (README's MCP setup goes in #175).",
    until: "#177",
  },
  {
    path: /^site\//,
    reason: "The landing page's copy and wordmark.",
    until: "#178",
  },
  {
    path: /^apps\/edge\/wrangler\.jsonc$/,
    reason: "Cloudflare resource names: Worker, D1 database and R2 bucket.",
    until: "#180",
  },
];

type Hit = { path: string; text: string };

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
      if (!/zibel/i.test(rest)) return false;
    }
    return true;
  });
  return { uncovered, unused: allowlist.filter((e) => !used.has(e)) };
}

function trackedHits(): Hit[] {
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
  const lines = (s: string) => s.split("\n").filter(Boolean);
  const inContent = lines(git("grep", "-I", "-i", "-n", "zibel", "--", ".")).map((l) => {
    const [, path = "", line, text = ""] = l.match(/^(.+?):(\d+):(.*)$/) ?? [];
    return { path, text, line: Number(line) };
  });
  const inPaths = lines(git("ls-files")).filter((p) => /zibel/i.test(p));
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
        { path: "packages/core/src/x.ts", text: "export class ZibelThing {}" },
        { path: "packages/core/src/zibel.ts", text: "packages/core/src/zibel.ts" },
        { path: "packages/io/src/read.ts", text: `// Read zibel:stack; Zibel's own.` },
        { path: "packages/io/src/read.ts", text: `"A star Zibel cannot hold."` },
      ],
      ALLOWLIST,
    );
    expect(uncovered.map((h) => h.text)).toEqual([
      "export class ZibelThing {}",
      "packages/core/src/zibel.ts",
    ]);
  });

  it("covers a hit only in the files and tokens its entry names", () => {
    const entry: Entry = { path: /^a\.ts$/, token: /zibel_\w+/g, reason: "r", until: "#175" };
    const { uncovered, unused } = check(
      [
        { path: "a.ts", text: "zibel_export and Zibel" },
        { path: "b.ts", text: "zibel_export" },
      ],
      [entry, { path: /^never$/, reason: "stale", until: "#177" }],
    );
    expect(uncovered.map((h) => h.path)).toEqual(["a.ts", "b.ts"]);
    expect(unused.map((e) => e.reason)).toEqual(["stale"]);
  });
});
