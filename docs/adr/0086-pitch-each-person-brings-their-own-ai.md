---
status: accepted
date: 2026-10-01
---

# Pitch: each person brings their own AI to one Document

REQUIREMENTS §1.1 and §1.2 pitched Kalamo as the vector editor an agent can draw in, with people refining the result. On 2026-10-01 Haiku 4.5 ran four tasks once through the Kalamo MCP tools and once writing an SVG file (`docs/research/11-mcp-vs-svg.md`). Writing SVG was as good or better on every task and cost 4–9 times less, partly because every MCP turn reads about 100k tokens of tool definitions. An agent that can write files already draws one-off pictures without Kalamo, so drawing alone does not set Kalamo apart. The owner chose a new pitch on 2026-10-01 (#228). It amends REQUIREMENTS §1.1–1.3, §3, §5.18 and §9.

## Decision

**Each person brings their own AI agent, and everyone, people and agents, edits the same Document.** A designer working with Claude Code and a product manager working with Claude Desktop open one Document. Each agent connects through its own MCP client with its own token, so it is its own Actor, and works on the shared Document alongside both people. The result is deliverable vector work that round-trips with Inkscape (ADR-0017), not a whiteboard sketch.

1. **Kalamo ships no AI of its own.** People connect the MCP client they already use. Kalamo's part is the shared Document: the edits, who made them, and how agents and people see each other's work. This follows from MCP-first (§1.3 goal 3) and stateless Streamable HTTP (ADR-0006): any client that speaks MCP over HTTP can join.
2. **The pitch rests on what exists.** Members with Roles and per-Agent tokens (ADR-0047), Actors on every Transaction (F-COLLAB-07), `doc_changes` since a `rev` (F-COLLAB-01) and `ifRev` conflicts already let several agents and one person share a Document. What is missing is people seeing each other in the browser.
3. **Presence moves into M1.** F-COLLAB-05 splits. Cursors and selections of other browser Users become P1 and part of M1. Comments stay P2. F-COLLAB-04 (an Agent's working area and its `intent` shown in the UI) moves from M3 into M1 too: with several agents on one Document, people need to see which agent is doing what. Soft locks (F-COLLAB-03) stay in M3.
4. **Illustrator parity stays the drawing target.** The drawing features, the Inkscape round trip and the milestones' drawing scope are unchanged. Kalamo does not take on whiteboard features (sticky notes, a pen that only sketches, an infinite low-fidelity canvas).
5. **Tool definitions must shrink.** A pitch built on agents joining a Document fails if each agent pays 100k tokens per turn to join. Reducing the tool definitions becomes M1 scope.

## Considered options

- **An AI whiteboard** (diagrams for people to talk through, drawn by AI). Rejected. tldraw, Excalidraw, Miro and FigJam already ship one, and REQUIREMENTS §1.2 positions Kalamo against whiteboards whose output is a sketch. Kalamo's investments (Bezier editing, compound shapes, a layout engine) would go unused.
- **Keep "an agent can draw" as the pitch.** Rejected on the 2026-10-01 measurements: an agent writing SVG matches it.
- **A built-in AI assistant.** Rejected. It ties people to one vendor and one bill, and it duplicates what their own MCP clients already do.

## Consequences

- REQUIREMENTS: §1.1's one-liner, §1.2's gap, §1.3 goal 4, a §3 persona and story, §5.18's priorities, §9's M1 and M3 rows, and §10.2 decision 65.
- `pnpm bench` gains tasks where people and several agents share a Document, and a write-SVG baseline arm, so a task shows what Kalamo adds over writing a file (#231, #233).
- Tool definitions shrink (#229); Area Type reports its laid-out height (#230); presence in the browser (#232).
- The landing page (#234) and the promotional video say "people and their own AIs, on one canvas" rather than "AI draws".
