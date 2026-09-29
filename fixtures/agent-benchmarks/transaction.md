## Prompt

Using the kalamo tools, create a Document named exactly `{{name}}` with one 300×300 pt Artboard at the origin.

Then, inside one Transaction, draw a simple house from five shapes: a body, a roof, a door and two windows. Use at least two `kalamo_node_create` calls within the Transaction, and nothing outside it may change the Document. Commit the Transaction, then call `kalamo_render` to check the drawing.

## Assertions

- After the Document's creation (rev 1), exactly one change is committed, and it creates at least five Nodes.
- The Agent called `kalamo_tx_begin` and `kalamo_tx_commit` exactly once each, `kalamo_node_create` at least twice between them, and `kalamo_render` after the commit.
