/**
 * Slice `items` into fixed-size chunks, preserving order.
 *
 * Used wherever a batch has to be split to respect an API or query limit
 * (Google People members:modify caps at ~1000, Postgres `IN (...)` lists,
 * Gmail batch modify). Previously open-coded in four modules.
 *
 * A non-positive `size` returns a single chunk rather than looping forever.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
