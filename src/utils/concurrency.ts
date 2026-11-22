/**
 * Pure concurrency helpers (no DB, Discord or logger imports, so tests can
 * load them without env).
 */

/**
 * Wrap an async job so overlapping callers share one in-flight run: while a
 * run is pending every call returns that same promise (same result or same
 * rejection); once it settles the next call starts a fresh run.
 */
export function createSingleFlight<T>(job: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return () => {
    if (inFlight) return inFlight
    let p: Promise<T>
    try {
      p = job()
    } catch (err) {
      p = Promise.reject(err)
    }
    const shared = p.finally(() => {
      if (inFlight === shared) inFlight = null
    })
    inFlight = shared
    return shared
  }
}

type Timer = ReturnType<typeof setTimeout>

/** Opaque token proving the holder still owns a key's reservation. */
export type SlotToken = { readonly key: string }

/**
 * Per-key timer registry with a synchronous reservation step, so an async
 * scheduler can claim a key before its first `await` and a second concurrent
 * call sees the key as taken. A reservation is either committed to a timer,
 * released, or invalidated by `cancel` (after which `commit` refuses).
 */
export function createTimerSlots() {
  const slots = new Map<string, Timer | SlotToken>()
  const tokens = new WeakSet<object>()
  const isToken = (v: Timer | SlotToken | undefined, token: SlotToken): boolean => v === token
  const isSlotToken = (v: Timer | SlotToken): v is SlotToken => typeof v === 'object' && v !== null && tokens.has(v)

  return {
    has(key: string): boolean {
      return slots.has(key)
    },
    /** Claim `key`; returns null if it is already reserved or armed. */
    reserve(key: string): SlotToken | null {
      if (slots.has(key)) return null
      const token: SlotToken = { key }
      tokens.add(token)
      slots.set(key, token)
      return token
    },
    /** True while `token` still holds `key` (not cancelled, released or committed). */
    holds(key: string, token: SlotToken): boolean {
      return isToken(slots.get(key), token)
    },
    /** Arm `timer` for a still-valid reservation. Returns false if the reservation was cancelled or replaced. */
    commit(key: string, token: SlotToken, timer: Timer): boolean {
      if (!isToken(slots.get(key), token)) return false
      slots.set(key, timer)
      return true
    },
    /** Drop a reservation that will not be armed (no-op if no longer held). */
    release(key: string, token: SlotToken): void {
      if (isToken(slots.get(key), token)) slots.delete(key)
    },
    /** Arm `timer` unconditionally, clearing any timer already set for `key`. */
    set(key: string, timer: Timer): void {
      const prev = slots.get(key)
      if (prev !== undefined && !isSlotToken(prev)) clearTimeout(prev)
      slots.set(key, timer)
    },
    /** Called from a timer's callback: remove the entry only if it is still that timer. */
    fired(key: string, timer: Timer): void {
      if (slots.get(key) === timer) slots.delete(key)
    },
    /**
     * Clear and remove whatever is held for `key`. Returns true if an armed
     * timer was cleared; a pending reservation is invalidated (false).
     */
    cancel(key: string): boolean {
      const prev = slots.get(key)
      if (prev === undefined) return false
      slots.delete(key)
      if (isSlotToken(prev)) return false
      clearTimeout(prev)
      return true
    },
  }
}
