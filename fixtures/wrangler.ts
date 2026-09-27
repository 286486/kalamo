// A local `wrangler dev` of the Worker for the scripts outside `pnpm check` (`bench`, `roundtrip`).
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

/** Starts `wrangler dev` on `port` with its state in `state`, and resolves once it answers. */
export async function startServer(port: number, state: string): Promise<{ stop(): void }> {
  mkdirSync(state, { recursive: true });
  const log = openSync(join(state, "wrangler.log"), "w");
  const server = spawn(
    "wrangler",
    // Dev mode with the scripts' own tokens, over whatever apps/edge/.dev.vars says (ADR-0047).
    [
      "dev",
      "-c",
      "apps/edge/wrangler.jsonc",
      "--port",
      String(port),
      "--persist-to",
      state,
      "--var",
      "AUTH_MODE:dev",
      "--var",
      "DEV_TOKENS:dev-token-a=agent-a,dev-token-b=agent-b",
    ],
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
  try {
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null)
        throw new Error(`wrangler dev exited; see ${state}/wrangler.log`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/docs`)).ok) return { stop };
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`wrangler dev did not answer in 60 s; see ${state}/wrangler.log`);
  } catch (e) {
    stop();
    throw e;
  }
}
