// `pnpm bench [--model <model>] [task…]`: runs each task's prompts through `claude -p` against a
// local `wrangler dev`, then checks the Document it drew through MCP (REQUIREMENTS §9.0). A task
// with an `## SVG prompt` runs again with only Read, Write and Edit on files, as its write-SVG
// baseline (research 11), and is judged by opening what it wrote in Kalamo. Not run in CI.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startServer } from "../wrangler.ts";
import { type Check, type Files, httpCall, type Setup, type SvgCheck } from "./mcp.ts";

const PORT = 8790;
const MCP = `http://127.0.0.1:${PORT}/mcp`;
const TOKEN = "dev-token-a";
/** The second Actor a setup edits as, whose changes an Agent must find. */
const OTHER_TOKEN = "dev-token-b";
const STATE = ".wrangler/bench";
const TIMEOUT_MS = 10 * 60_000;
const here = import.meta.dirname;

type Arm = "mcp" | "svg";

interface Run {
  tools: string[];
  turns: number;
  ms: number;
  cost: number;
  /** The first turn's input tokens in thousands: the tool definitions and system prompt. */
  prefix: number;
  /** Input tokens in thousands over all turns, cache reads included. */
  input: number;
  /** The share of `input` written to the cache, which costs more than reading it. */
  cacheWrite: number;
  model: string;
  error?: string;
}

interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}
const inputOf = (u: Usage) =>
  (u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens) / 1000;

const ARM_ARGS: Record<Arm, string[]> = {
  // Only the Kalamo MCP server and its resources.
  mcp: [
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        kalamo: { type: "http", url: MCP, headers: { Authorization: `Bearer ${TOKEN}` } },
      },
    }),
    "--tools",
    "ListMcpResourcesTool,ReadMcpResourceTool",
    "--allowedTools",
    "mcp__kalamo,ListMcpResourcesTool,ReadMcpResourceTool",
  ],
  // Only the files in its working directory.
  svg: ["--tools", "Read,Write,Edit", "--allowedTools", "Read,Write,Edit"],
};

/** One `claude -p` session of `arm` in `cwd`. */
async function agent(
  log: string,
  arm: Arm,
  cwd: string,
  prompt: string,
  model?: string,
): Promise<Run> {
  // Without an API key --bare cannot authenticate; no setting sources then keeps user and
  // project settings, hooks and plugins out instead.
  const isolation = process.env.ANTHROPIC_API_KEY ? ["--bare"] : ["--setting-sources", ""];
  const args = [
    "-p",
    ...isolation,
    ...(model ? ["--model", model] : []),
    "--strict-mcp-config",
    ...ARM_ARGS[arm],
    "--disable-slash-commands",
    "--verbose",
    "--output-format",
    "stream-json",
  ];
  // The parent Claude Code session's variables (session id, effort) must not leak into the run.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^CLAUDE/.test(k) || k === "CLAUDE_CODE_OAUTH_TOKEN" || k === "CLAUDE_CONFIG_DIR",
    ),
  );
  const child = spawn("claude", args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "inherit"],
    timeout: TIMEOUT_MS,
  });
  let spawnError: string | undefined;
  child.on("error", (e) => {
    spawnError = `claude: ${e.message}`;
  });
  child.stdin.end(prompt);
  child.stdout.setEncoding("utf8");
  let stream = "";
  for await (const chunk of child.stdout) stream += chunk;
  writeFileSync(join(STATE, `${log}.jsonl`), stream);

  const run: Run = {
    tools: [],
    turns: 0,
    ms: 0,
    cost: 0,
    prefix: 0,
    input: 0,
    cacheWrite: 0,
    model: "?",
    error: spawnError,
  };
  for (const line of stream.split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === "system" && event.subtype === "init") {
      run.model = event.model;
      const server = event.mcp_servers.find((s: { name: string }) => s.name === "kalamo");
      if (arm === "mcp" && server?.status !== "connected")
        run.error = `kalamo MCP server ${server?.status}`;
    }
    if (event.type === "assistant" && !run.prefix) run.prefix = inputOf(event.message.usage);
    if (event.type === "assistant")
      for (const block of event.message.content)
        if (block.type === "tool_use") run.tools.push(block.name.replace(/^mcp__kalamo__/, ""));
    if (event.type === "result") {
      run.turns = event.num_turns;
      run.ms = event.duration_ms;
      run.cost = event.total_cost_usd;
      run.input = inputOf(event.usage);
      run.cacheWrite = event.usage.cache_creation_input_tokens / 1000;
      if (event.is_error) run.error ??= `claude: ${event.subtype}`;
    }
  }
  if (!stream.includes('"type":"result"')) run.error ??= "claude exited without a result";
  return run;
}

/** A task's sessions in a row, one Run summed over them; `prefix` stays the first session's. */
async function sessions(
  log: string,
  arm: Arm,
  cwd: string,
  prompts: string[],
  model?: string,
): Promise<Run> {
  let total: Run | undefined;
  for (const [i, prompt] of prompts.entries()) {
    const run = await agent(prompts.length > 1 ? `${log}-${i + 1}` : log, arm, cwd, prompt, model);
    total = total && {
      ...total,
      tools: [...total.tools, ...run.tools],
      turns: total.turns + run.turns,
      ms: total.ms + run.ms,
      cost: total.cost + run.cost,
      input: total.input + run.input,
      cacheWrite: total.cacheWrite + run.cacheWrite,
      error: total.error ?? run.error,
    };
    total ??= run;
    if (total.error) break;
  }
  return total as Run;
}

/** A Markdown section's prompts: its sessions, split by `---` lines, with `vars` filled in. */
const promptsOf = (section: string | undefined, vars: Record<string, string>) =>
  (section ?? "")
    .split(/^---$/m)
    .map((p) => p.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`).trim())
    .filter(Boolean);

const report = (task: string, arm: Arm, run: Run, error?: string) =>
  console.log(
    [
      task.padEnd(12),
      arm,
      error ? "FAIL" : "pass",
      `calls=${run.tools.length}`,
      `turns=${run.turns}`,
      `${(run.ms / 1000).toFixed(1)}s`,
      `$${run.cost.toFixed(2)}`,
      `in=${run.input.toFixed(0)}k`,
      `prefix=${run.prefix.toFixed(1)}k`,
      `cacheWrite=${run.cacheWrite.toFixed(0)}k`,
      `model=${run.model}`,
      error ? `\n  ${error}` : "",
    ].join("  "),
  );

const { values: opts, positionals: only } = parseArgs({
  allowPositionals: true,
  options: { model: { type: "string" } },
});

const server = await startServer(PORT, STATE);

let failed = 0;
try {
  const call = httpCall(MCP, TOKEN);
  const other = httpCall(MCP, OTHER_TOKEN);
  const tasks = readdirSync(here)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .filter((t) => only.length === 0 || only.includes(t));
  for (const task of tasks) {
    const md = readFileSync(join(here, `${task}.md`), "utf8");
    const section = (title: string) =>
      md
        .split(/^## /m)
        .find((s) => s.startsWith(`${title}\n`))
        ?.slice(title.length);
    const {
      default: check,
      setup,
      svgCheck,
    } = (await import(`./${task}.ts`)) as { default: Check; setup?: Setup; svgCheck?: SvgCheck };

    const arms: Arm[] = section("SVG prompt") && svgCheck ? ["mcp", "svg"] : ["mcp"];
    for (const arm of arms) {
      // Each arm starts from its own copy of what the prompts say exists.
      const name = `bench-${task}-${arm}-${Date.now().toString(36)}`;
      const start = await setup?.(call, name, other);
      const cwd = mkdtempSync(join(tmpdir(), `kalamo-bench-${task}-${arm}-`));
      let run: Run;
      let error: string | undefined;
      if (arm === "mcp") {
        const prompts = promptsOf(section("Prompt"), { name, docId: start?.docId ?? "" });
        run = await sessions(`${task}-mcp`, arm, cwd, prompts, opts.model);
        error = run.error;
        if (!error) {
          try {
            let docId = start?.docId;
            if (!docId) {
              const { documents } = (await call("kalamo_doc_list", {})).structuredContent as {
                documents: { docId: string; name: string }[];
              };
              const docs = documents.filter((d) => d.name === name);
              if (docs.length !== 1)
                throw new Error(`${docs.length} Documents named ${name}, want 1`);
              docId = docs[0]?.docId ?? "";
            }
            await check(call, docId, run.tools);
          } catch (e) {
            error = (e as Error).message;
          }
        }
      } else {
        for (const [file, text] of Object.entries(start?.files ?? {}))
          writeFileSync(join(cwd, file), text);
        run = await sessions(
          `${task}-svg`,
          arm,
          cwd,
          promptsOf(section("SVG prompt"), {}),
          opts.model,
        );
        error = run.error;
        if (!error) {
          const files: Files = Object.fromEntries(
            readdirSync(cwd).map((f) => [f, readFileSync(join(cwd, f), "utf8")]),
          );
          try {
            await svgCheck?.(call, files);
          } catch (e) {
            error = (e as Error).message;
          }
        }
      }
      if (error) failed++;
      report(task, arm, run, error);
    }
  }
} finally {
  server.stop();
}
process.exit(failed ? 1 : 0);
