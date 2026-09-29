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

/**
 * Takes in the keys that the former origin's last page carried here in the URL fragment,
 * `#carry=<JSON of former key → text>` (#180), under Kalamo's keys. A key already stored under
 * either name wins. Drops the fragment either way; blocked storage or a garbled fragment is ignored.
 */
export function receiveCarried() {
  const carried = location.hash.match(/^#carry=(.*)$/)?.[1];
  if (carried === undefined) return;
  history.replaceState(history.state, "", location.pathname + location.search);
  try {
    const values: Record<string, unknown> = JSON.parse(decodeURIComponent(carried));
    for (const key of ["kalamo:tabs", "kalamo:pencil"] as const) {
      const value = values?.[key.replace(/^kalamo:/, `${LEGACY_NAME}:`)];
      if (typeof value === "string" && getItem(key) === null) localStorage.setItem(key, value);
    }
  } catch {}
}
