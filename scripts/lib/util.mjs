// scripts/lib/util.mjs — small shared helpers for the stats scripts.

// Civ display name → URL/cache slug. All AoE2 civ names are single words, so this collapses to
// name.toLowerCase() in practice; normalising in one place keeps keying consistent if a
// multi-word name ever ships.
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);

// Run an array of async tasks with bounded concurrency. Returns each worker's result in order
// (callers that mutate shared state inside the worker can ignore the return value). Single-threaded
// JS means there are no data races on state mutated between `await` points.
export async function pool(items, worker, n) {
  const out = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return out;
}
