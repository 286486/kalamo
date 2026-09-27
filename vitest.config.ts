import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./apps/edge/migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./apps/edge/wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          AUTH_MODE: "dev",
          DEV_TOKENS: "dev-token-a=agent-a,dev-token-b=agent-b",
        },
      },
    }),
  ],
  test: {
    include: [
      "apps/*/test/**/*.test.ts",
      "apps/web/src/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
    ],
    setupFiles: ["./apps/edge/test/setup.ts"],
  },
});
