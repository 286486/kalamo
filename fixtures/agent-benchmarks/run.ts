// `pnpm bench [task…]`: runs each task's prompt through `claude -p` against a local `wrangler dev`,
// then checks the Document it drew through MCP (REQUIREMENTS §9.0). Not run in CI.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../wrangler.ts";
import { type Check, httpCall, type Setup } from "./mcp.ts";

const PORT = 8790;
const MCP = `http://127.0.0.1:${PORT}/mcp`;
const TOKEN = "dev-token-a";
const STATE = ".wrangler/bench";
const TIMEOUT_MS = 10 * 60_000;
const here = import.meta.dirname;

interface Run {
  tools: string[];
  turns: number;
  ms: number;
  cost: number;
  model: string;
  error?: string;
}

/** One `claude -p` session that sees only the Kalamo MCP server and its resources. */
async function agent(task: string, prompt: string): Promise<Run> {
  const mcpConfig = {
    mcpServers: {
      kalamo: { type: "http", url: MCP, headers: { Authorization: `Bearer ${TOKEN}` } },
    },
  };
  // Without an API key --bare cannot authenticate; no setting sources then keeps user and
  // project settings, hooks and plugins out instead.
  const isolation = process.env.ANTHROPIC_API_KEY ? ["--bare"] : ["--setting-sources", ""];
  const args = [
    "-p",
    ...isolation,
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(mcpConfig),
    "--disable-slash-commands",
    "--tools",
    "ListMcpResourcesTool,ReadMcpResourceTool",
    "--allowedTools",
    "mcp__kalamo,ListMcpResourcesTool,ReadMcpResourceTool",
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
    cwd: mkdtempSync(join(tmpdir(), `kalamo-bench-${task}-`)),
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
  writeFileSync(join(STATE, `${task}.jsonl`), stream);

  const run: Run = { tools: [], turns: 0, ms: 0, cost: 0, model: "?", error: spawnError };
  for (const line of stream.split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === "system" && event.subtype === "init") {
      run.model = event.model;
      const server = event.mcp_servers.find((s: { name: string }) => s.name === "kalamo");
      if (server?.status !== "connected") run.error = `kalamo MCP server ${server?.status}`;
    }
    if (event.type === "assistant")
      for (const block of event.message.content)
        if (block.type === "tool_use") run.tools.push(block.name.replace(/^mcp__kalamo__/, ""));
    if (event.type === "result") {
      run.turns = event.num_turns;
      run.ms = event.duration_ms;
      run.cost = event.total_cost_usd;
      if (event.is_error) run.error ??= `claude: ${event.subtype}`;
    }
  }
  if (!stream.includes('"type":"result"')) run.error ??= "claude exited without a result";
  return run;
}

const server = await startServer(PORT, STATE);

let failed = 0;
try {
  const call = httpCall(MCP, TOKEN);
  const only = process.argv.slice(2);
  const tasks = readdirSync(here)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .filter((t) => only.length === 0 || only.includes(t));
  for (const task of tasks) {
    const name = `bench-${task}-${Date.now().toString(36)}`;
    const md = readFileSync(join(here, `${task}.md`), "utf8");
    const prompt = md
      .split("## Assertions")[0]
      ?.replace("## Prompt", "")
      .replaceAll("{{name}}", name);
    const { default: check, setup } = (await import(`./${task}.ts`)) as {
      default: Check;
      setup?: Setup;
    };
    await setup?.(call, name);
    const run = await agent(task, prompt?.trim() ?? "");
    let error = run.error;
    if (!error) {
      try {
        const { documents } = (await call("kalamo_doc_list", {})).structuredContent as {
          documents: { docId: string; name: string }[];
        };
        const docs = documents.filter((d) => d.name === name);
        if (docs.length !== 1) throw new Error(`${docs.length} Documents named ${name}, want 1`);
        await check(call, docs[0]?.docId ?? "", run.tools);
      } catch (e) {
        error = (e as Error).message;
      }
    }
    if (error) failed++;
    console.log(
      [
        task.padEnd(12),
        error ? "FAIL" : "pass",
        `tools=${run.tools.length}`,
        `turns=${run.turns}`,
        `${(run.ms / 1000).toFixed(1)}s`,
        `$${run.cost.toFixed(2)}`,
        `model=${run.model}`,
        error ? `\n  ${error}` : "",
      ].join("  "),
    );
  }
} finally {
  server.stop();
}
process.exit(failed ? 1 : 0);
