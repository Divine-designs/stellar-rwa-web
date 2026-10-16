/**
 * Deduplicate in-flight requests to prevent refetch storms when multiple
 * components request the same data simultaneously.
 */

type CacheKey = string;
type CacheEntry<T> = {
  promise: Promise<T>;
  timestamp: number;
};

const inFlightRequests = new Map<CacheKey, CacheEntry<unknown>>();
const CACHE_DURATION_MS = 5000; // 5 seconds

/**
 * Execute a factory function once, sharing the result for any concurrent
 * calls with the same key. Once the promise settles, it's removed from
 * the cache so subsequent calls can refetch.
 */
export function dedupeRequest<T>(
  key: CacheKey,
  factory: () => Promise<T>
): Promise<T> {
  const cached = inFlightRequests.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
    // The map stores Promise<unknown> since it's shared across callers with
    // different T; callers are responsible for using a key whose cached
    // value actually matches the T they ask for.
    return cached.promise as Promise<T>;
  }

  const promise = factory().finally(() => {
    // Clean up after a short delay to allow concurrent consumers to receive the result
    setTimeout(() => {
      if (inFlightRequests.get(key)?.promise === promise) {
        inFlightRequests.delete(key);
      }
    }, 0);
  });

  inFlightRequests.set(key, { promise, timestamp: Date.now() });
  return promise;
}

/**
 * Clear all cached requests (useful for testing).
 */
export function clearRequestCache(): void {
  inFlightRequests.clear();
}
