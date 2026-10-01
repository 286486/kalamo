// `pnpm bench [--model <model>] [task…]`: runs each task's prompts through `claude -p` against a
// local `wrangler dev`, then checks the Document it drew through MCP (REQUIREMENTS §9.0). A task
// with an `## SVG prompt` runs again with only Read, Write and Edit on files, as its write-SVG
// baseline (research 11), and is judged by opening what it wrote in Kalamo. Every MCP call goes
// through a proxy that logs it, and lets a task's people edit before it is forwarded. Not run in CI.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startServer } from "../wrangler.ts";
import {
  type Agent,
  type Check,
  type Connect,
  type Files,
  httpCall,
  type Interject,
  type Logged,
  type Setup,
  type SvgCheck,
} from "./mcp.ts";

const PORT = 8790;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MCP = `${ORIGIN}/mcp`;
/** Where the Agents' MCP client connects: the proxy in front of `MCP`. */
const PROXY_PORT = 8791;
const TOKEN = "dev-token-a";
/** The second Actor a setup edits as, whose changes an Agent must find. */
const OTHER_TOKEN = "dev-token-b";
/** The dev tokens' Actors, as `startServer` sets DEV_TOKENS. */
const TOKENS: Record<string, string> = { "agent-a": TOKEN, "agent-b": OTHER_TOKEN };
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

/** An arm's tools; an MCP session connects with `token`. */
const armArgs = (arm: Arm, token: string) =>
  ({
    // Only the Kalamo MCP server and its resources.
    mcp: [
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          kalamo: {
            type: "http",
            url: `http://127.0.0.1:${PROXY_PORT}/mcp`,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }),
      "--tools",
      "ListMcpResourcesTool,ReadMcpResourceTool",
      "--allowedTools",
      "mcp__kalamo,ListMcpResourcesTool,ReadMcpResourceTool",
    ],
    // Only the files in its working directory.
    svg: ["--tools", "Read,Write,Edit", "--allowedTools", "Read,Write,Edit"],
  })[arm];

/** The current arm's Agent calls, and its people's hook; reset before each arm. */
let calls: Logged[] = [];
/** The MCP client each token last said it was, in `initialize`'s clientInfo. */
const clients = new Map<string | undefined, string>();
let interject: Interject | undefined;
let interjectError: string | undefined;

/** Forwards each request to `MCP`, logging tool calls and running `interject` before each. */
const proxy = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  const actor = Object.keys(TOKENS).find((a) => TOKENS[a] === token) ?? "?";
  let rpc:
    | {
        method?: string;
        params?: { name: string; arguments: unknown; clientInfo?: { name: string } };
      }
    | undefined;
  try {
    rpc = JSON.parse(body);
  } catch {}
  if (rpc?.method === "initialize") clients.set(token, rpc.params?.clientInfo?.name ?? "?");
  const tool = rpc?.method === "tools/call" ? rpc.params : undefined;
  if (tool)
    await interject?.(actor, tool.name, tool.arguments).catch((e: Error) => {
      interjectError ??= `the people's edit before ${actor}'s ${tool.name}: ${e.message}`;
    });
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers))
    if (typeof v === "string" && !["host", "connection", "content-length"].includes(k))
      headers.set(k, v);
  const up = await fetch(MCP, { method: req.method, headers, body: body || undefined });
  const text = await up.text();
  if (tool) {
    let result: Logged["result"];
    try {
      result = JSON.parse(text).result;
    } catch {}
    const client = clients.get(token) ?? "?";
    calls.push({ actor, client, name: tool.name, args: tool.arguments, result });
  }
  const type = up.headers.get("content-type");
  res.writeHead(up.status, type ? { "content-type": type } : {});
  res.end(text);
});

/** A dev-mode browser socket, as the `kalamo_dev_user` cookie names its User (ADR-0090). */
const connect: Connect = async (user, docId) =>
  new WebSocket(`${ORIGIN.replace(/^http/, "ws")}/api/docs/${docId}/ws`, {
    headers: { cookie: `kalamo_dev_user=${user}` },
  } as unknown as string[]);

/** One `claude -p` session of `arm` in `cwd`. */
async function agent(
  log: string,
  arm: Arm,
  cwd: string,
  prompt: string,
  token: string,
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
    ...armArgs(arm, token),
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

/** One `codex exec` session in `cwd` with only the Kalamo MCP server: a second MCP client. */
async function codex(log: string, cwd: string, prompt: string, token: string): Promise<Run> {
  const started = Date.now();
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    // Its default model, and no user MCP servers, plugins or rules.
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--disable",
    "shell_tool",
    "-s",
    "read-only",
    "-C",
    cwd,
    "-c",
    `mcp_servers.kalamo.url="http://127.0.0.1:${PROXY_PORT}/mcp"`,
    "-c",
    'mcp_servers.kalamo.bearer_token_env_var="KALAMO_TOKEN"',
    "-c",
    // Its writes would otherwise wait for an approval that exec mode cannot give.
    'mcp_servers.kalamo.default_tools_approval_mode="approve"',
    "-c",
    'approval_policy="never"',
    "-",
  ];
  const child = spawn("codex", args, {
    cwd,
    env: { ...process.env, KALAMO_TOKEN: token },
    stdio: ["pipe", "pipe", "inherit"],
    timeout: TIMEOUT_MS,
  });
  const run: Run = {
    tools: [],
    turns: 0,
    ms: 0,
    cost: 0, // codex reports no cost
    prefix: 0,
    input: 0,
    cacheWrite: 0,
    model: "codex",
  };
  child.on("error", (e) => {
    run.error = `codex: ${e.message}`;
  });
  child.stdin.end(prompt);
  child.stdout.setEncoding("utf8");
  let stream = "";
  for await (const chunk of child.stdout) stream += chunk;
  writeFileSync(join(STATE, `${log}.jsonl`), stream);
  for (const line of stream.split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === "item.completed" && event.item.type === "mcp_tool_call")
      run.tools.push(event.item.tool);
    if (event.type === "turn.completed") {
      run.turns++;
      run.input += event.usage.input_tokens / 1000;
      run.cacheWrite += (event.usage.cache_write_input_tokens ?? 0) / 1000;
    }
    if (event.type === "turn.failed" || event.type === "error")
      run.error ??= `codex: ${JSON.stringify(event.error ?? event.message)}`;
  }
  if (!run.turns) run.error ??= "codex exited without a completed turn";
  run.ms = Date.now() - started;
  return run;
}

/**
 * A task's sessions in a row, one Run summed over them; `prefix` stays the first session's.
 * Session i runs as `agents[i]`, `agent-a` in Claude Code when the task names none; the SVG arm
 * always runs in Claude Code.
 */
async function sessions(
  log: string,
  arm: Arm,
  cwd: string,
  prompts: string[],
  agents: Agent[],
  model?: string,
): Promise<Run> {
  let total: Run | undefined;
  for (const [i, prompt] of prompts.entries()) {
    const { actor, client } = agents[i] ?? { actor: "agent-a", client: "claude" };
    const token = TOKENS[actor] ?? TOKEN;
    const name = prompts.length > 1 ? `${log}-${i + 1}` : log;
    const run =
      arm === "mcp" && client === "codex"
        ? await codex(name, cwd, prompt, token)
        : await agent(name, arm, cwd, prompt, token, model);
    total = total
      ? {
          ...total,
          tools: [...total.tools, ...run.tools],
          turns: total.turns + run.turns,
          ms: total.ms + run.ms,
          cost: total.cost + run.cost,
          input: total.input + run.input,
          cacheWrite: total.cacheWrite + run.cacheWrite,
          model: total.model === run.model ? total.model : `${total.model}+${run.model}`,
          error: total.error ?? run.error,
        }
      : run;
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
await new Promise<void>((r) => proxy.listen(PROXY_PORT, "127.0.0.1", r));

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
      agents = [],
    } = (await import(`./${task}.ts`)) as {
      default: Check;
      setup?: Setup;
      svgCheck?: SvgCheck;
      agents?: Agent[];
    };

    const arms: Arm[] = section("SVG prompt") && svgCheck ? ["mcp", "svg"] : ["mcp"];
    for (const arm of arms) {
      // Each arm starts from its own copy of what the prompts say exists.
      const name = `bench-${task}-${arm}-${Date.now().toString(36)}`;
      const start = await setup?.(call, name, other, connect);
      calls = [];
      interject = start?.interject;
      interjectError = undefined;
      const cwd = mkdtempSync(join(tmpdir(), `kalamo-bench-${task}-${arm}-`));
      let run: Run;
      let error: string | undefined;
      if (arm === "mcp") {
        const prompts = promptsOf(section("Prompt"), { name, docId: start?.docId ?? "" });
        run = await sessions(`${task}-mcp`, arm, cwd, prompts, agents, opts.model);
        error = run.error ?? interjectError;
        writeFileSync(join(STATE, `${task}-mcp-calls.json`), JSON.stringify(calls, null, 1));
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
            await check(call, docId, run.tools, { calls, commits: start?.commits ?? [] });
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
          agents,
          opts.model,
        );
        error = run.error;
        if (!error) {
          try {
            const files: Files = Object.fromEntries(
              readdirSync(cwd, { withFileTypes: true })
                .filter((f) => f.isFile())
                .map((f) => [f.name, readFileSync(join(cwd, f.name), "utf8")]),
            );
            await svgCheck?.(call, files);
          } catch (e) {
            error = (e as Error).message;
          }
        }
      }
      start?.close?.();
      if (error) failed++;
      report(task, arm, run, error);
    }
  }
} finally {
  proxy.close();
  server.stop();
}
process.exit(failed ? 1 : 0);
