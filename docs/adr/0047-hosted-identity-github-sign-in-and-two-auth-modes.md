---
status: accepted
date: 2026-09-27
---

# Hosted identity: two auth modes, GitHub sign-in and D1 sessions

Until now the Worker had one mode. `/mcp` took a fixed `DEV_TOKENS` Bearer token (ADR-0006), every browser route was unauthenticated (ADR-0009), and every browser edit was the Actor `user` (ADR-0010). The M1 hosted launch puts the Worker on the public internet (#117). This ADR records the first slice (#118): who a request is, how a browser signs in, and how the Document Durable Object learns the Actor. MCP OAuth (slice 2) and Document ownership with Roles (slice 3) extend it.

## Decision

- **Two auth modes.** `AUTH_MODE` is `dev` or `github`.
  - `dev` is today's behaviour: MCP takes the `DEV_TOKENS` Bearer tokens, and every browser is the local User `local` with the Actor `user`. `.dev.vars`, the Workers test pool, the e2e suite and the bench and round-trip scripts set it. It is safe only on a private network.
  - `github` is the default in `wrangler.jsonc`, and any value other than `dev` means `github`, so a deploy that sets no mode is never open. It answers every request 500 `server misconfigured` while `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `APP_ORIGIN` or the `DB` binding is missing. Until MCP OAuth, `/mcp` still takes `DEV_TOKENS` tokens and refuses every request when none are set.
- **Principal.** A request resolves to at most one `Principal` `{ userId, actor, access }` through one authentication function per mode. `actor` is the id the Delta Log records. `access` is always `write` for a browser. Every browser route takes its Actor from the Principal. A User's Actor is `user_<userId>`.
- **GitHub sign-in.** A GitHub OAuth App, asked for no scopes, so Zibel reads only the public profile.
  - `GET /auth/github?return=<path>` sends the browser to GitHub with a random `state` kept, with the return path, in a 10-minute HttpOnly `__Host-` cookie.
  - `GET /auth/github/callback` refuses a missing or mismatched `state` with 400. It exchanges the code, reads `GET https://api.github.com/user`, upserts the User by GitHub's numeric id (refreshing the login and avatar), creates the User's `kind='user'` Actor row at the first sign-in, starts a session and redirects to the return path. A return path that is not a same-site path is `/`.
  - The GitHub access token lives only in the callback's memory. Nothing stores it.
  - User ids are Zibel's own ULIDs, not `github:<id>`, because the OAuth provider library of slice 2 forbids `:` in a user id.
- **Sessions in D1.** The cookie `__Host-zibel_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`) holds 32 random bytes. D1 keeps only their SHA-256 with the user id and the created and last-seen times. A session unused for 30 days answers 401; its last-seen time moves at most once a day. The cookie's own lifetime is 400 days, the most a browser keeps, so the server alone decides expiry. `POST /auth/signout` deletes the row, so the cookie stops working at once. `GET /api/me` answers `{ userId, login, avatarUrl, mode }`, the local User in dev mode, or 401.
- **Origin check.** In GitHub mode, every request other than `/mcp` that is not a GET or HEAD, and every WebSocket upgrade, must carry `Origin` equal to `APP_ORIGIN`, or it gets 403 `PERMISSION_DENIED`. This stops other sites from acting with a person's cookie (CSRF, cross-site WebSocket hijacking). SameSite=Lax is the second line of defence. `/mcp` is exempt: it authenticates by a Bearer header, which no page can make a browser send.
- **The Worker sets the Actor on the WebSocket.** The Worker replaces any client-sent `x-zibel-actor` with the Principal's Actor on the upgrade. The Document Durable Object refuses an upgrade without it, keeps it in the socket's serialized attachment, which survives hibernation, and records every command, undo and redo from that socket under it. The Durable Object stays trust-free: only the Worker can reach it (REQUIREMENTS §7.5). The Role joins the header in slice 3.
- **Browser.** When `/api/me` answers 401, the Document list offers "Sign in with GitHub" and every other page sends the person there with a return path. A signed-in person sees their login, avatar and Sign out at the menu bar's right end. Dev mode shows nothing new.

## Considered Options

- **Sessions in KV.** Cheaper reads, but KV is eventually consistent for up to a minute, so a signed-out cookie would keep working elsewhere. D1 makes sign-out immediate, and slice 3 resolves the session, the User and the Role in one query.
- **A signed cookie with no server state.** No lookup per request, but sign-out could not end it before it expires.
- **Dev mode as the default.** Friendlier locally, but a deploy that forgot the setting would serve a public Worker with no auth.
- **The Actor as a Durable Object RPC argument on the upgrade.** A WebSocket upgrade must go through `fetch`, which carries only a request, so the Actor rides in a header the Worker owns.
- **Sliding the cookie's `Max-Age` with the session.** Each slide would need a `Set-Cookie` on whatever response is in flight. A long-lived cookie with the expiry kept in D1 has one place to look.

## Consequences

- In GitHub mode, a signed-in User still reaches every Document until slice 3 adds ownership and Roles, and MCP still uses `DEV_TOKENS` until slice 2. Do not treat a GitHub-mode deploy as private until both land.
- `doc_changes` and the browser show Actor ids such as `user_01J…`; resolving them to names is a follow-up. The `actors` rows exist for it.
- `pnpm deploy` reads its secrets from `apps/edge/.deploy.vars`, not `.dev.vars`, whose `AUTH_MODE="dev"` must never reach a deployed Worker.
- ADR-0009's and ADR-0010's "until OAuth" consequences end here for the browser.
