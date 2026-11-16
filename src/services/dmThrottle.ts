/**
 * Rate limit for owner error DMs (logger.errorAndDm). Pure: no config/env,
 * db, logger or settings imports, and the clock is injectable, so it is
 * unit-tested in test/dmThrottle.test.ts.
 *
 * Per key: at most one DM per `windowMs`; repeats inside the window are
 * counted and reported on the next DM for that key. Globally: at most
 * `globalMax` DMs per `globalWindowMs` across all keys; a DM dropped by the
 * global cap is counted against its key the same way.
 */

export const DM_KEY_WINDOW_MS = 10 * 60 * 1000
export const DM_GLOBAL_MAX = 10
export const DM_GLOBAL_WINDOW_MS = 60 * 60 * 1000
export const DM_MAX_KEYS = 200

export interface DmThrottleOptions {
  windowMs?: number
  globalMax?: number
  globalWindowMs?: number
  maxKeys?: number
  now?: () => number
}

export type DmDecision = { send: true; suppressed: number } | { send: false }

interface KeyEntry {
  lastSentAt: number | null
  suppressed: number
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err !== null && typeof err === 'object') {
    try {
      const json = JSON.stringify(err)
      if (typeof json === 'string') return json
    } catch {
      // circular or BigInt: fall through
    }
  }
  return String(err)
}

/** Throttle key: the log message plus the first line of the error. */
export function dmThrottleKey(message: string, err: unknown): string {
  const text = describe(err)
  const firstLine = text.split('\n', 1)[0] ?? ''
  return `${message}|${firstLine.slice(0, 300)}`
}

/** Suffix appended to a DM that stands in for dropped repeats. */
export function formatSuppressed(count: number): string {
  return count > 0 ? `\n(+${count} suppressed)` : ''
}

export class DmThrottle {
  private readonly windowMs: number
  private readonly globalMax: number
  private readonly globalWindowMs: number
  private readonly maxKeys: number
  private readonly now: () => number
  private readonly keys = new Map<string, KeyEntry>()
  private sentAt: number[] = []

  constructor(opts: DmThrottleOptions = {}) {
    this.windowMs = opts.windowMs ?? DM_KEY_WINDOW_MS
    this.globalMax = opts.globalMax ?? DM_GLOBAL_MAX
    this.globalWindowMs = opts.globalWindowMs ?? DM_GLOBAL_WINDOW_MS
    this.maxKeys = opts.maxKeys ?? DM_MAX_KEYS
    this.now = opts.now ?? Date.now
  }

  /**
   * Decide whether a DM for `key` goes out now. Records the decision.
   * `bypassGlobal` skips the hourly cap (still counted toward it) but not the
   * per-key window; used for the crash DM, which must not be crowded out.
   */
  check(key: string, opts: { bypassGlobal?: boolean } = {}): DmDecision {
    const now = this.now()
    let entry = this.keys.get(key)
    if (!entry) {
      entry = { lastSentAt: null, suppressed: 0 }
      this.keys.set(key, entry)
      this.prune(now)
    }

    if (entry.lastSentAt !== null && now - entry.lastSentAt < this.windowMs) {
      entry.suppressed += 1
      return { send: false }
    }

    this.sentAt = this.sentAt.filter(t => now - t < this.globalWindowMs)
    if (!opts.bypassGlobal && this.sentAt.length >= this.globalMax) {
      entry.suppressed += 1
      return { send: false }
    }

    const suppressed = entry.suppressed
    entry.lastSentAt = now
    entry.suppressed = 0
    this.sentAt.push(now)
    return { send: true, suppressed }
  }

  /** Number of tracked keys (for tests). */
  size(): number {
    return this.keys.size
  }

  private prune(now: number): void {
    if (this.keys.size <= this.maxKeys) return
    for (const [k, e] of this.keys) {
      if (e.lastSentAt !== null && now - e.lastSentAt >= this.windowMs) this.keys.delete(k)
    }
    // Still over: drop the oldest-inserted keys (their suppressed counts are lost).
    for (const k of this.keys.keys()) {
      if (this.keys.size <= this.maxKeys) break
      this.keys.delete(k)
    }
  }
}
