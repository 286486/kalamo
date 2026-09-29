// A local `wrangler dev` of a Worker: the editor for the scripts outside `pnpm check` (`bench`,
// `roundtrip`), and kalamo-site for fixtures/site.test.ts.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Starts `wrangler dev` on `port` with its state in `state`, and resolves once `ready` answers. */
export async function startServer(
  port: number,
  state: string,
  {
    // Dev mode with the scripts' own tokens, over whatever apps/edge/.dev.vars says (ADR-0047).
    args = [
      "-c",
      "apps/edge/wrangler.jsonc",
      "--var",
      "AUTH_MODE:dev",
      "--var",
      "DEV_TOKENS:dev-token-a=agent-a,dev-token-b=agent-b",
    ],
    ready = "/api/docs",
    seconds = 60,
  } = {},
): Promise<{ stop(): void }> {
  mkdirSync(state, { recursive: true });
  const log = openSync(join(state, "wrangler.log"), "w");
  const server = spawn(
    "wrangler",
    ["dev", ...args, "--port", String(port), "--persist-to", state],
    { detached: true, stdio: ["ignore", log, log] },
  );
  const stop = () => {
    try {
      if (server.pid) process.kill(-server.pid, "SIGTERM");
    } catch {} // already exited
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });
  for (let i = 0; i < seconds * 2 && server.exitCode === null; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}${ready}`)).ok) return { stop };
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const why = server.exitCode === null ? `did not answer in ${seconds} s` : "exited";
  stop();
  let tail = ""; // the log's tail, readable after the caller deletes `state`
  try {
    tail = readFileSync(join(state, "wrangler.log"), "utf8").slice(-2000).trimEnd();
  } catch {}
  throw new Error(`wrangler dev ${why}; see ${state}/wrangler.log${tail && `\n${tail}`}`);
}
