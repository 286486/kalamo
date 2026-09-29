# Zibel

Browser-based vector drawing tool with an MCP-native document model: AI agents and people edit the same Illustrator-style canvas. Read `docs/REQUIREMENTS.md` before proposing scope or architecture changes, and `docs/research/` for the evidence behind it. Milestones are in its §9.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `286486/kalamo`, driven through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.

## Conventions

- Talk to the user in Chinese. Code, identifiers, comments, commit messages, docs, ADRs and this file are in English.
- `docs/REQUIREMENTS.md` and `CONTEXT.md` are in Chinese for now; translate to English before the M1 public announcement and keep the Chinese copies under `docs/zh/`.
- Canonical terms come from `CONTEXT.md` and follow Adobe Illustrator's names. Use `compound_shape`, not `boolean`; `Actor`, not `session`.
- MCP is stateless Streamable HTTP only (ADR-0006). Never add stdio, `Mcp-Session-Id`, subscriptions, or elicitation.

## Branches and merging

Never switch branches in the main checkout. Do each change on a new branch `<issue-number>-<slug>` from `origin/main`, in a worktree at `.claude/worktrees/<issue-number>-<slug>` (`EnterWorktree`, or `git worktree add -b`), and run `pnpm install` in it. When dispatching a subagent, pass the worktree path; do not use `isolation: "worktree"`, which creates a second one. No pull requests: merge locally, in the main checkout on `main`, with `git merge --no-ff <branch>`, then `git push origin main`. Remove the worktree and delete the branch once it is merged.
