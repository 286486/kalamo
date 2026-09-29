import { LEGACY_NAME } from "@kalamo/core";
import { afterEach, expect, it, vi } from "vitest";
import { receiveCarried } from "./storage.ts";

/** A page at `/docs/d#<hash>` with the given storage; returns it and the URL the page ends at. */
function page(hash: string, stored = new Map<string, string>()) {
  const at = { url: `/docs/d#${hash}` };
  vi.stubGlobal("location", { hash: `#${hash}`, pathname: "/docs/d", search: "" });
  vi.stubGlobal("history", {
    state: null,
    replaceState: (_: unknown, __: string, url: string) => (at.url = url),
  });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => stored.set(k, v),
    removeItem: (k: string) => stored.delete(k),
  });
  return { stored, at };
}
const carry = (values: unknown) => `carry=${encodeURIComponent(JSON.stringify(values))}`;

afterEach(() => vi.unstubAllGlobals());

it("stores the carried tabs and Pencil options under Kalamo's keys and drops the fragment", () => {
  const { stored, at } = page(
    carry({ [`${LEGACY_NAME}:tabs`]: '["a"]', [`${LEGACY_NAME}:pencil`]: "{}", other: "x" }),
  );
  receiveCarried();
  expect([...stored]).toEqual([
    ["kalamo:tabs", '["a"]'],
    ["kalamo:pencil", "{}"],
  ]);
  expect(at.url).toBe("/docs/d");
});

it("keeps a key already stored here, under either name", () => {
  const stored = new Map([
    ["kalamo:tabs", '["here"]'],
    [`${LEGACY_NAME}:pencil`, '{"fidelity":1}'],
  ]);
  page(carry({ [`${LEGACY_NAME}:tabs`]: '["a"]', [`${LEGACY_NAME}:pencil`]: "{}" }), stored);
  receiveCarried();
  expect(Object.fromEntries(stored)).toEqual({
    "kalamo:tabs": '["here"]',
    "kalamo:pencil": '{"fidelity":1}',
  });
});

it("ignores a garbled fragment, values that are not text, and blocked storage", () => {
  for (const hash of ["carry=%7Bnot-json", carry({ [`${LEGACY_NAME}:tabs`]: 5 }), carry(null)]) {
    const { stored, at } = page(hash);
    receiveCarried();
    expect([...stored]).toEqual([]);
    expect(at.url).toBe("/docs/d");
  }
  page(carry({ [`${LEGACY_NAME}:tabs`]: '["a"]' }));
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
  });
  expect(() => receiveCarried()).not.toThrow();
});
