# A shared function that turns a parsed file into a Document

Core does not export a function that builds a `Document` from the file shape
`{ name, artboards, nodes: Node[], images }` that `parseDocument` and `parseFile` return.
Each site that needs a Document writes the object literal itself.

## Why this is out of scope

`Document` is a seven-field interface. Building one from a parse result means
listing those fields and one `new Map(nodes.map((n) => [n.id, n]))` line. A
helper would remove about six lines per site and add a new public export to core.

The copies cannot drift without being noticed. Every site is either typed
`Document` or is passed straight to a function that takes one. If `Document`
gains or changes a required field, `tsc` fails at each site, so `pnpm check`
catches it.

The values that look inconsistent are each test's own choice, not drift.
`dialect.test.ts` uses `id: "DOC"` and `rev: 1`, `file.test.ts` uses `id: "d"`, and
other tests use `rev: 0`. The tests set them on purpose. Inside `parseDocument`, the
Document's `id: ""` and `rev: 0` are never read: `checkTree` reads only `nodes` and
`artboards`.

Production has two sites: the throwaway Document for `checkTree` in
`parseDocument`, and `DocumentObject.open` in edge, which sets the real `docId`.
They share only the field assembly. A public helper whose defaults are
`id: ""` and `rev: 0` would also let production code create Documents with an
empty id.

The test migration would leave two styles in the repo anyway. About 20 test sites
build `{ ...doc, nodes: new Map(parsed.nodes…) }` on purpose, and they must keep
doing so.

## When to reconsider

- `Document` gains a field derived from its Nodes (an index or a cache) that
  every construction must build the same way, so a literal can no longer be
  correct by inspection.
- A third production caller builds a Document from the parsed file shape.

## Prior requests

- #248: "One core function turns a parsed file into a Document, used by
  parseDocument, edge Open and the tests that rebuild one"
