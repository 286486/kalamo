# Zibel

A vector drawing tool that runs in the browser, built so AI agents can read and write the document through MCP while a person edits the same file in a normal Illustrator-style canvas.

![A night landscape with its ridge path's anchors and handles, an Agent → Document ← Person diagram, and a stacked bar chart](docs/images/readme-hero.png)

An Agent drew this over MCP: Live Shapes, Bezier paths and text in two Layers, with each label centred from the bounds the server measured, then exported to PNG with `zibel_export`.

Zibel is a short form of Zobel / zibeline, the sable marten whose hair makes the finest illustration brushes.

## Status

Milestone M0 is in progress (issue #1). A local Worker already takes MCP calls to create a Document, draw shapes into it, read its outline and render it to PNG. A browser viewer shows each Document live as an Agent draws, and a person can select, move and delete what it drew.

Start here. Domain vocabulary is in [CONTEXT.md](CONTEXT.md) and architecture decisions in [docs/adr/](docs/adr/).

| Document | Contents |
|---|---|
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Requirements v0.4 (Chinese). Scope, functional requirements, MCP tool surface, architecture, milestones, Illustrator feature mapping |
| [docs/research/01-illustrator-core-features.md](docs/research/01-illustrator-core-features.md) | Adobe Illustrator tools, panels, workflows and scripting DOM, from the official user guide |
| [docs/research/02-web-vector-tech-landscape.md](docs/research/02-web-vector-tech-landscape.md) | Figma, Penpot, Excalidraw, tldraw and Graphite architecture; rendering, boolean, text, freehand and sync library choices |
| [docs/research/03-mcp-design-tool-patterns.md](docs/research/03-mcp-design-tool-patterns.md) | How existing MCP servers expose design tools, and what breaks |

## Local development

Needs Node 22 or later.

```sh
corepack enable
pnpm install
pnpm check   # typecheck, Biome, and Vitest inside workerd
pnpm test:e2e # Playwright smoke test against its own wrangler dev (needs `pnpm exec playwright install chromium`)
pnpm dev     # builds the web app, then wrangler dev: viewer at http://localhost:8787, MCP at /mcp
```

Every MCP request needs `Authorization: Bearer <dev token>`. Copy `apps/edge/.dev.vars.example` to `apps/edge/.dev.vars` and set the `DEV_TOKENS` token-to-Agent-Actor pairs. Documents are stored under `.wrangler/state` and survive a restart of `pnpm dev`. The viewer lists them at http://localhost:8787 and opens one at `/docs/<docId>`: Space-drag or scroll to pan, Ctrl+scroll or pinch to zoom, Z then click (Alt+click) to zoom in (out), Ctrl+0 to fit the Artboards, Ctrl+1 for 100%. Click an object to select it (Shift-click toggles, Alt+Shift-click removes) or drag a marquee over several; drag the Selection to move it, press Delete or Backspace to delete it, Ctrl+A to select all and Ctrl+Shift+A to deselect. Each move or delete is one Transaction by the Actor `user`. Ctrl+Z undoes the Document's latest Transaction, whoever made it, including an Agent's whole Transaction in one step, and Ctrl+Shift+Z redoes it; both are Transactions too. The viewer has no login in M0. The first `pnpm dev` asks once to apply the local D1 migration that indexes Documents.

To connect Claude Code, copy [examples/claude-code.mcp.json](examples/claude-code.mcp.json) to `.mcp.json`, or run:

```sh
claude mcp add --transport http zibel http://localhost:8787/mcp -H "Authorization: Bearer YOUR_TOKEN"
```

## Cloudflare preview deployment

The current M0 browser API has no login. Treat the `workers.dev` deployment as public and do not put sensitive documents there until M1 adds OAuth.

```sh
pnpm exec wrangler login
cp apps/edge/.dev.vars.example apps/edge/.dev.vars # replace DEV_TOKENS with a long random token
pnpm exec wrangler d1 create zibel --location apac --binding DB --update-config -c apps/edge/wrangler.jsonc
pnpm deploy:check
pnpm deploy
```

`pnpm deploy` builds the web app, applies remote D1 migrations, uploads `DEV_TOKENS` as an encrypted Worker secret, and deploys the Worker, Durable Object, and static assets. The resulting `workers.dev` URL needs no domain configuration; add a custom domain later in Cloudflare if wanted.

## What it is meant to do

Three kinds of work, all producing editable vector output rather than images:

- Charts and diagrams, from data or from a Mermaid description
- Illustration, icons and logos, with Bezier paths, boolean operations, gradients and an appearance stack
- Freehand drawing with pressure, fitted to editable curves

Agents drive it over MCP. Every edit a person can make in the UI has a matching tool call, and every write returns both the affected node IDs and an optional rendered preview, so an agent can check its own work.

## Planned shape

- Document model is a flat, ID-keyed scene graph serialised as readable JSON
- Rendering starts on Canvas2D and moves to Skia via CanvasKit as object counts grow
- Boolean operations use Skia PathOps; text is shaped with HarfBuzz
- Hosted on Cloudflare, with one Durable Object per document holding authoritative state; the same Worker bundle runs locally under `wrangler dev` and self-hosted under workerd
- MCP is stateless Streamable HTTP only: no stdio, no MCP sessions, every request carries its own token and document address
- Monorepo under `apps/` and `packages/`, laid out in REQUIREMENTS.md section 8.3

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The Zibel name and logo are not covered by that licence.
