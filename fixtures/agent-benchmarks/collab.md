## Prompt

Using the kalamo tools, edit the Kalamo Document `{{docId}}`. Two people and another agent edit it at the same time as you, each with their own tools; keep every change they make. Pass `ifRev` on each write, and when one fails with `REV_CONFLICT`, read what changed with `kalamo_doc_changes` before you write again.

Draft a process diagram in its Layer: five rects named `Step 1` to `Step 5`, each 120×80 pt and filled `#E63946`, the top-left corner of `Step i` at x = 40 + 150 × (i − 1), y = 120. Draw nothing else.

---

Using the kalamo tools, edit the Kalamo Document `{{docId}}`. Two people and another agent edit it at the same time as you, each with their own tools; keep every change they make. Pass `ifRev` on each write, and when one fails with `REV_CONFLICT`, read what changed with `kalamo_doc_changes` before you write again.

Restyle the diagram by this rule: every rect filled `#E63946` gets the fill `#3565E8` and one 2 pt `#1D3557` Stroke. Change nothing else.

## Assertions

The M1 exit benchmark (ADR-0086): two Agent Actors with their own tokens in two different MCP clients, `agent-a` in Claude Code (`claude -p`) and then `agent-b` in Codex (`codex exec`, its shell tool off), and two browser Users, `alice` and `bob`, each on the Document's WebSocket as dev mode's `kalamo_dev_user` cookie names them (ADR-0090). The setup creates an empty 800×320 pt Document. The bench forwards every Agent call to `/mcp` through a proxy, and the people edit just before each Agent's first write is forwarded, so that write's `ifRev` is stale:

- before `agent-a`'s, `alice` adds the Point Type `Title`, `Release plan`, at (40, 60);
- before `agent-b`'s, `alice` moves `Step 2` 40 pt down and `bob` recolours `Step 4` `#2A9D8F`.

Then:

- The Document holds the five rects and `Title`, nothing else, and no one's change is lost: each rect is 120×80 pt where `agent-a` drew it, `Step 2` 40 pt lower; `Step 4` is `#2A9D8F` with no Stroke; the others are `#3565E8` with one 2 pt `#1D3557` Stroke.
- The two Agents came from two different MCP clients: every call of one Agent's carries the `clientInfo.name` its client sent in `initialize`, and the two names differ.
- Each Agent had a write fail with `REV_CONFLICT`, and after every such failure it called `kalamo_doc_changes` from at most the `ifRev` it had passed before its next write that succeeded.
- History attributes every change to its Actor: `kalamo_doc_changes` from rev 0 lists exactly the setup's, the people's and the Agents' committed writes, each with the Actor that made it.
