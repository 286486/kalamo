import { LEGACY_NAME } from "@kalamo/core";

/**
 * The stored text of `kalamo:<name>`. When it is absent, the same key under the former name moves to
 * it once, so the rename loses no browser state (ADR-0069). Throws as localStorage does when
 * storage is blocked.
 */
export function getItem(key: `kalamo:${string}`): string | null {
  const value = localStorage.getItem(key);
  if (value !== null) return value;
  const legacy = key.replace(/^kalamo:/, `${LEGACY_NAME}:`);
  const old = localStorage.getItem(legacy);
  if (old === null) return null;
  localStorage.setItem(key, old);
  localStorage.removeItem(legacy);
  return old;
}
