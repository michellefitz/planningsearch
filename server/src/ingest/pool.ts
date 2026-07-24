/**
 * Run an async mapper over a list with bounded concurrency.
 *
 * Build-time ingest is dominated by network latency: fetching one URL at a time
 * (with a politeness sleep between each) means the build spends most of its
 * life idle. A small pool keeps a handful of requests in flight — still a
 * modest, considerate load on the public services, but minutes faster.
 *
 * Results come back in input order. The mapper is expected to handle its own
 * failures; a rejection propagates.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await mapper(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
