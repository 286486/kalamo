import { defineConfig, devices } from "@playwright/test";

const PORT = 8788;
/** Its own state, so test Documents never show up in `pnpm dev`'s list. */
const STATE = "--persist-to .wrangler/e2e -c apps/edge/wrangler.jsonc";
/** Dev mode with the suite's own tokens, over whatever apps/edge/.dev.vars says (ADR-0047). */
const VARS = "--var AUTH_MODE:dev --var DEV_TOKENS:dev-token-a=agent-a,dev-token-b=agent-b";

export default defineConfig({
  testDir: "apps/web/e2e",
  forbidOnly: !!process.env.CI,
  use: { baseURL: `http://localhost:${PORT}`, ...devices["Desktop Chrome"] },
  webServer: {
    command: [
      "pnpm --filter @kalamo/web build",
      `wrangler d1 migrations apply zibel --local ${STATE}`,
      `wrangler dev ${STATE} ${VARS} --port ${PORT}`,
    ].join(" && "),
    url: `http://localhost:${PORT}/api/docs`,
    reuseExistingServer: false,
    timeout: 120_000,
    // Non-interactive: wrangler applies the migration without asking and sends no metrics.
    env: { CI: "1", WRANGLER_SEND_METRICS: "false" },
  },
});
