---
status: accepted
date: 2026-10-02
---

# TypeScript projects are split by the runtime their code runs on

Kalamo's TypeScript runs in three environments: Cloudflare Workers, Node and the browser. Their global types collide. Node's and Workers' `Buffer`, `fetch`, `Response` and `Disposable` differ, and DOM types collide with workers-types. So each environment gets its own project, and `pnpm check` runs `tsc --noEmit` on all three (#249).

## Decision

1. **The root `tsconfig.json` is Workers-only.** It covers `apps/*/src`, `apps/*/test` and `packages/*/src`, with `@cloudflare/workers-types` and `@cloudflare/vitest-plugin/types`. No file in it may reach Node's types.
2. **`fixtures/tsconfig.json` is the Node project.** It extends the root options and replaces only `types`, with `["node"]`. It covers every `.ts` under `fixtures/` and root-level Node tooling, now `vitest.config.ts`.
3. **`apps/web/tsconfig.json` owns DOM typing.**
4. **New TypeScript that runs on Node joins the Node project**, including scripts and config files at the repo root. It must not go in the root project. A dependency's `/// <reference types="node" />` resolves to the installed `@types/node`, and `types` cannot block that, so one Node file in the root project pulls Node's globals into the Workers program. `vitest.config.ts` did exactly this: through `@cloudflare/vitest-plugin`, miniflare and undici, it broke root `tsc` in `apps/edge` once `@types/node` was installed.

## Considered Options

- **One project with Node and Workers types.** `Buffer.copy` and `Buffer.equals` fail to type-check, and Workers code would see Node globals that are absent at runtime.
- **Keep `vitest.config.ts` in the root project.** Root `tsc` fails with TS7022 and TS2352 in `apps/edge`.
- **Leave Node code unchecked.** This was the state before #249, and it hid 7 type errors in the round-trip harness.
