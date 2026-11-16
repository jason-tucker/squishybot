/**
 * Pure helpers for swapping a DB snapshot into a live in-memory cache without
 * losing mutations that landed while the snapshot queries were in flight, plus
 * the boot-time retry schedule for the settings load.
 *
 * Kept free of env/db/logger/settings imports so it can be unit-tested
 * directly (test/cacheMerge.test.ts).
 */

/** The in-memory caches owned by settings.ts. */
export type CacheKind = 'settings' | 'sudo' | 'threads' | 'hubs' | 'autoText' | 'autoVoice'

/**
 * Keys mutated in each cache while one reload was in flight. For a touched
 * key the live cache (written by the mutator after its DB write, or ahead of
 * it in the hub-swap case) is authoritative over the possibly stale snapshot.
 */
export type ReloadTracker = Record<CacheKind, Set<string>>

export function createReloadTracker(): ReloadTracker {
  return {
    settings: new Set(),
    sudo: new Set(),
    threads: new Set(),
    hubs: new Set(),
    autoText: new Set(),
    autoVoice: new Set(),
  }
}

/** Record `key` of `kind` as mutated on every active tracker. */
export function touchTrackers(trackers: Iterable<ReloadTracker>, kind: CacheKind, key: string): void {
  for (const t of trackers) t[kind].add(key)
}

/**
 * Replace `live` with `snapshot` in place, except that every key in `touched`
 * keeps its live state (present with its live value, or absent). Synchronous,
 * so readers never see a half-applied cache.
 */
export function mergeMapSnapshot<V>(
  live: Map<string, V>,
  snapshot: ReadonlyMap<string, V>,
  touched: ReadonlySet<string>,
): void {
  const kept = new Map<string, V>()
  for (const key of touched) {
    if (live.has(key)) kept.set(key, live.get(key) as V)
  }
  live.clear()
  for (const [key, value] of snapshot) {
    if (!touched.has(key)) live.set(key, value)
  }
  for (const [key, value] of kept) live.set(key, value)
}

/** Set counterpart of {@link mergeMapSnapshot}. */
export function mergeSetSnapshot(
  live: Set<string>,
  snapshot: ReadonlySet<string>,
  touched: ReadonlySet<string>,
): void {
  const kept: string[] = []
  for (const key of touched) {
    if (live.has(key)) kept.push(key)
  }
  live.clear()
  for (const key of snapshot) {
    if (!touched.has(key)) live.add(key)
  }
  for (const key of kept) live.add(key)
}

// ---------------------------------------------------------------------------
// Boot retry schedule (M7)
// ---------------------------------------------------------------------------

/** Waits between boot attempts of loadSettings: 6 attempts over about 38 s. */
export const SETTINGS_LOAD_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 20_000]

/** Interval of the background retry after the boot attempts are exhausted. */
export const SETTINGS_BACKGROUND_RETRY_MS = 60_000

export type RetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: unknown; attempts: number }

/**
 * Run `fn`; on rejection wait `delays[i]` and try again, so it runs at most
 * `delays.length + 1` times. Never throws. `sleep` is injectable for tests.
 */
export async function retryWithDelays<T>(
  fn: () => Promise<T>,
  delays: readonly number[],
  opts: {
    sleep?: (ms: number) => Promise<void>
    onRetry?: (attempt: number, error: unknown, delayMs: number) => void
  } = {},
): Promise<RetryResult<T>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let attempt = 0
  for (;;) {
    attempt++
    try {
      return { ok: true, value: await fn(), attempts: attempt }
    } catch (error) {
      const delayMs = delays[attempt - 1]
      if (delayMs === undefined) return { ok: false, error, attempts: attempt }
      opts.onRetry?.(attempt, error, delayMs)
      await sleep(delayMs)
    }
  }
}
