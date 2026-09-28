// Test harness: createMcpServer over an in-memory MCP transport against a recording
// DocumentService stub (ADR-0020). Only the methods a test hands in answer; every other call
// rejects, so the stub never grows into a fake Document.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import type { DocumentService } from "@zibel/sync";
import { type Mock, vi } from "vitest";
import { createMcpServer } from "./server.ts";

/** Ajv compiles with new Function, which workerd refuses; the server validates its own output. */
const acceptAll: jsonSchemaValidator = {
  getValidator: () => (data) => ({ valid: true, data: data as never, errorMessage: undefined }),
};

type Recorded = { [K in keyof DocumentService]: Mock<DocumentService[K]> };

export async function harness(overrides: Partial<DocumentService> = {}, actor = "agent-a") {
  const mocks = new Map<string, Mock>();
  const service = new Proxy({} as Recorded, {
    get: (_, name: string) => {
      let mock = mocks.get(name);
      if (!mock) {
        const own = overrides[name as keyof DocumentService] as
          | ((...args: unknown[]) => unknown)
          | undefined;
        mock = vi.fn(own ?? (() => Promise.reject(new Error(`no stub for ${name}`))));
        mocks.set(name, mock);
      }
      return mock;
    },
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(service, actor).connect(serverSide);
  const client = new Client(
    { name: "test", version: "0" },
    {
      jsonSchemaValidator: acceptAll,
    },
  );
  await client.connect(clientSide);
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  /** The service methods called so far, by name. */
  const called = () => [...mocks].filter(([, m]) => m.mock.calls.length > 0).map(([name]) => name);
  return { client, service, log, call, called };
}
