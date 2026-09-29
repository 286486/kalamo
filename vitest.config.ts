import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./apps/edge/migrations");

export default defineConfig({
  test: {
    projects: [
      {
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
          name: "workers",
          include: [
            "apps/*/test/**/*.test.ts",
            "apps/web/src/**/*.test.ts",
            "packages/*/src/**/*.test.ts",
          ],
          setupFiles: ["./apps/edge/test/setup.ts"],
        },
      },
      // Repo-level checks that read the working tree through git, which workerd cannot.
      { test: { name: "repo", include: ["fixtures/*.test.ts"], environment: "node" } },
    ],
  },
});
