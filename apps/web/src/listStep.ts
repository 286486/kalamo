/**
 * The index to focus in a list of `count` items when `key` is pressed on item `at` (-1 when
 * none has focus), or null when `key` does not move through the list. `step` maps the keys that
 * go to the previous (-1) or next (1) item, both wrapping; Home and End go to the ends. From no
 * item, previous goes to the last, as WAI-ARIA's menu pattern says.
 */
export function listStep(
  key: string,
  at: number,
  count: number,
  step: Readonly<Record<string, -1 | 1>>,
): number | null {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const by = step[key];
  if (!by) return null;
  if (at < 0) return by > 0 ? 0 : count - 1;
  return (at + by + count) % count;
}
