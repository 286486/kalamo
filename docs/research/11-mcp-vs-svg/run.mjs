// A/B: Haiku 4.5 drawing through Kalamo MCP vs writing SVG directly (docs/research/11-mcp-vs-svg.md).
// Needs a local Kalamo on :8795 in dev auth mode with token dev-token-a, e.g.
//   wrangler dev -c apps/edge/wrangler.jsonc --var AUTH_MODE:dev --var DEV_TOKENS:dev-token-a=agent-a --port 8795
// then `node docs/research/11-mcp-vs-svg/run.mjs [task…]`. Each run's stream, summary and drawing
// land in .wrangler/mcp-vs-svg/<task>-<arm>/.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dirname;
const OUT = join(HERE, "../../../.wrangler/mcp-vs-svg");
const MCP = "http://127.0.0.1:8795/mcp";
const MODEL = "claude-haiku-4-5-20251001";

let rpc = 1;
async function call(name, args) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer dev-token-a",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpc++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const j = await r.json();
  if (!j.result || j.result.isError)
    throw new Error(`${name}: ${JSON.stringify(j.error ?? j.result.content)}`);
  return j.result;
}

const POSTER = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <rect x="0" y="0" width="800" height="600" fill="#FFF8EE"/>
  <text x="400" y="110" font-family="Source Sans 3" font-weight="bold" font-size="64" text-anchor="middle" fill="#3D3D44">Summer Sale</text>
  <text x="400" y="160" font-family="Source Sans 3" font-size="24" text-anchor="middle" fill="#6B6B75">Up to 50% off everything</text>
  <circle cx="190" cy="330" r="70" fill="#E63946"/>
  <circle cx="400" cy="360" r="90" fill="#2A9D8F"/>
  <circle cx="620" cy="320" r="60" fill="#F4A261"/>
  <rect x="250" y="480" width="300" height="64" rx="32" fill="#3D3D44"/>
  <text x="400" y="521" font-family="Source Sans 3" font-weight="bold" font-size="26" text-anchor="middle" fill="#FFFFFF">Shop now</text>
  <path d="M 60 560 C 200 500 300 590 460 540" fill="none" stroke="#E9C46A" stroke-width="6"/>
</svg>
`;

const PARAGRAPH =
  "Kalamo is a vector editor that runs in the browser. AI agents draw on it through the Model Context Protocol, and people edit the very same document on an Illustrator-style canvas. Whatever an agent makes stays as paths, shapes and text, never as a flat picture, so anyone can pick up a curve, drag an anchor, retype a heading or change a colour and keep working by hand. When the person is done, the agent can read back exactly what changed and carry on from there, without redrawing the whole page or undoing the edits a person made along the way.";

const TASKS = {
  glass: {
    body: 'Draw a 1600 × 1000 poster in a "liquid coloured glass" style: translucent, glossy glass blobs in several vivid colours that overlap so their colours mix, a glass ring, a glass star and a few glass droplets, with highlights and soft coloured shadows, on a light background. Make it look as polished as you can.',
  },
  chart: {
    body: 'Draw a bar chart on an 800 × 500 canvas. Title: "Quarterly revenue 2026 (USD million)". Bars: Q1 12.4, Q2 18.9, Q3 15.2, Q4 24.7. A y axis from 0 to 30 with gridlines and tick labels every 5. Each bar has its value written just above it and its quarter written below it. Bars are #3565E8, except the highest, which is #FF7A59. Nothing may overlap and nothing may fall off the canvas.',
  },
  edit: {
    body: 'Change the title to "Autumn Sale" and make every circle #3565E8. Leave everything else exactly as it is.',
  },
  text: {
    body: `On a 600 × 800 canvas, set this paragraph in a text box 320 pt wide whose top-left corner is at x = 140, y = 120: 16 pt Source Sans 3, justified. Then draw a 1 pt #3D3D44 rectangle (no fill) exactly around the text box: 320 pt wide, and just tall enough for the text, with no line cut off and no more than one empty line below the last line. Paragraph:\n\n${PARAGRAPH}`,
  },
};

function prompt(task, arm, docId) {
  const t = TASKS[task];
  if (arm === "mcp") {
    const where =
      task === "edit"
        ? `A person made a poster; it is the Kalamo Document ${docId}. Edit that Document.`
        : `Use the Kalamo tools. Create a Document named "${task}" for it (the canvas is its Artboard).`;
    return `${where}\n\n${t.body}\n\nWhen you are done, reply with one line saying you are done.`;
  }
  const where =
    task === "edit"
      ? "A person made a poster; it is the file poster.svg in the current directory. Edit that file in place."
      : 'Write the result as one SVG file, out.svg, in the current directory. Use font-family "Source Sans 3" for any text.';
  return `${where}\n\n${t.body}\n\nWhen you are done, reply with one line saying you are done.`;
}

function claude(arm, cwd, text) {
  const mcpConfig = {
    mcpServers: {
      kalamo: { type: "http", url: MCP, headers: { Authorization: "Bearer dev-token-a" } },
    },
  };
  const args = [
    "-p",
    "--model",
    MODEL,
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--verbose",
    "--output-format",
    "stream-json",
  ];
  if (arm === "mcp")
    args.push(
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(mcpConfig),
      "--tools",
      "ListMcpResourcesTool,ReadMcpResourceTool",
      "--allowedTools",
      "mcp__kalamo,ListMcpResourcesTool,ReadMcpResourceTool",
    );
  else
    args.push(
      "--strict-mcp-config",
      "--tools",
      "Read,Write,Edit",
      "--allowedTools",
      "Read,Write,Edit",
    );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^CLAUDE/.test(k) || k === "CLAUDE_CODE_OAUTH_TOKEN" || k === "CLAUDE_CONFIG_DIR",
    ),
  );
  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "inherit"],
      timeout: 20 * 60_000,
    });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (out += c));
    child.on("close", () => resolve(out));
    child.stdin.end(text);
  });
}

function summarize(stream) {
  const s = { tools: [], turns: 0, ms: 0, cost: 0, in: 0, out: 0 };
  for (const line of stream.split("\n").filter(Boolean)) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "assistant")
      for (const b of e.message.content)
        if (b.type === "tool_use") s.tools.push(b.name.replace(/^mcp__kalamo__kalamo_/, ""));
    if (e.type === "result") {
      Object.assign(s, {
        turns: e.num_turns,
        ms: e.duration_ms,
        cost: e.total_cost_usd,
        error: e.is_error ? e.subtype : undefined,
        reply: e.result,
      });
      s.in =
        (e.usage?.input_tokens ?? 0) +
        (e.usage?.cache_read_input_tokens ?? 0) +
        (e.usage?.cache_creation_input_tokens ?? 0);
      s.out = e.usage?.output_tokens ?? 0;
    }
  }
  return s;
}

async function findDoc(name) {
  const docs = (await call("kalamo_doc_list", {})).structuredContent.documents;
  return docs.filter((d) => d.name === name).at(-1)?.docId;
}

async function runOne(task, arm) {
  const cwd = join(OUT, `${task}-${arm}`);
  mkdirSync(cwd, { recursive: true });
  let docId;
  if (task === "edit") {
    if (arm === "svg") writeFileSync(join(cwd, "poster.svg"), POSTER);
    else {
      docId = (await call("kalamo_doc_open", { content: POSTER })).structuredContent.docId;
    }
  }
  const stream = await claude(arm, cwd, prompt(task, arm, docId));
  writeFileSync(join(cwd, "stream.jsonl"), stream);
  const s = summarize(stream);
  if (arm === "mcp") {
    docId ??= await findDoc(task);
    if (docId) {
      const svg = await call("kalamo_export", { docId, format: "svg" });
      writeFileSync(join(cwd, "out.svg"), svg.content.find((c) => c.type === "text").text);
      const png = await call("kalamo_export", { docId, format: "png", scale: 2 });
      writeFileSync(
        join(cwd, "kalamo.png"),
        Buffer.from(png.content.find((c) => c.type === "image").data, "base64"),
      );
    } else s.error ??= "no Document";
  }
  writeFileSync(join(cwd, "summary.json"), JSON.stringify(s, null, 1));
  console.log(task, arm, JSON.stringify({ ...s, tools: s.tools.length, reply: undefined }));
  return s;
}

const tasks = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TASKS);
await Promise.all(tasks.flatMap((t) => [runOne(t, "mcp"), runOne(t, "svg")]));
