---
status: accepted
date: 2026-09-24
---

# MCP tools are tested at the `DocumentService` seam; the Worker suite tests the transport

Every MCP test used to go through the whole Worker: JSON-RPC over HTTP, `documentService`, Workers RPC, the Document Durable Object, then core. That file (`apps/edge/test/mcp.test.ts`) grew to 1600 lines, and much of it repeated core tests almost name for name. Meanwhile what only the MCP layer does had no test of its own: how each tool splits its arguments between the call and the write options, how a `KalamoError` becomes an error result, the result shapes and the published schemas (#46). `createMcpServer(service, actor)` already takes the seam as a parameter.

- **`packages/mcp` tests each tool against a recording stub.** The tests drive `createMcpServer` through the SDK's `Client` over `InMemoryTransport`, with no HTTP and no Worker. The stub is a `DocumentService` whose methods record their arguments. A test hands in the results it needs, and any other call rejects.
- **No behavioural fake.** A fake Document would re-implement Transactions, rev, undo and the Delta Log, and it would drift from the Durable Object. That behaviour stays tested in core and in the Durable Object (`runInDurableObject`).
- **The Worker suite keeps the transport and the wiring:** initialize, the tool and resource lists, 405 without sessions (ADR-0006), the error-hint contract end to end, and one smoke call per tool through the real Durable Object. It also keeps any behaviour that lives only in the Worker or the Durable Object, such as `FONT_MISSING` on write and the token-to-Actor mapping.
- **A Worker test is deleted only with a named replacement:** a core, Durable Object or mcp test that covers the same behaviour. The commit that deletes it says which one.

## Considered Options

- **A behavioural fake Document behind the seam.** Rejected above.
- **Worker tests only (the status quo).** Each fact about a tool costs a Durable Object round trip, and a failure does not say which layer broke.

## Consequences

- A new tool gets one seam test and one Worker smoke.
- The test `Client` runs with a validator that accepts everything, because the SDK's default, Ajv, compiles with `new Function`, which workerd refuses. The server still checks `structuredContent` against each tool's `outputSchema` with zod.
