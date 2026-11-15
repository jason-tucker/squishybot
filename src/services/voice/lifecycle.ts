/**
 * Pure decision helpers for the auto voice room lifecycle. Kept free of
 * config/env, db, logger and settings imports so they can be unit-tested
 * (test/voiceLifecycle.test.ts) without booting the bot.
 */
import { RESTJSONErrorCodes } from 'discord.js'

export type TransitionStep =
  | { kind: 'leave'; channelId: string }
  | { kind: 'join'; channelId: string }

/**
 * Which halves of a voiceStateUpdate to run, in order. A move between two
 * channels is a leave of the old one AND a join of the new one; the leave
 * runs first so the old room's text access, owner grace and empty-room
 * cleanup are handled even when the join half returns early (managed room,
 * static VC or hub). Same-channel updates (mute, deafen, stream) yield no steps.
 */
export function planTransition(leftId: string | null, joinedId: string | null): TransitionStep[] {
  const steps: TransitionStep[] = []
  if (leftId && leftId !== joinedId) steps.push({ kind: 'leave', channelId: leftId })
  if (joinedId && joinedId !== leftId) steps.push({ kind: 'join', channelId: joinedId })
  return steps
}

export type DeleteErrorClass = 'gone' | 'failed'

/**
 * A channel delete that fails with Unknown Channel (10003) means the channel
 * is already gone, which is the outcome we wanted. Any other error (missing
 * permissions, rate limit, network) means the channel may still exist, so
 * the caller must keep its DB row and retry later.
 */
export function classifyDeleteError(err: unknown): DeleteErrorClass {
  return (err as { code?: unknown } | null)?.code === RESTJSONErrorCodes.UnknownChannel ? 'gone' : 'failed'
}

export type DeleteOutcome = 'deleted' | 'gone' | 'failed'

/** Delete a channel by id and classify the result. Never throws. */
export async function tryDeleteChannel(
  channels: { delete(id: string): Promise<unknown> },
  channelId: string,
): Promise<{ outcome: DeleteOutcome; error?: unknown }> {
  try {
    await channels.delete(channelId)
    return { outcome: 'deleted' }
  } catch (error) {
    return { outcome: classifyDeleteError(error), error }
  }
}

/**
 * Runs async tasks one at a time per key, in submission order. discord.js
 * does not serialize voiceStateUpdate handlers, so a member's quick
 * A -> B -> leave sequence could otherwise interleave (a later leave of B
 * finishing before the earlier join of B cancels B's cleanup). Each task's
 * own result or rejection is returned to its caller; a rejection never
 * blocks the tasks queued after it. A key's entry is dropped once its queue
 * drains.
 *
 * A task that never settles would block its key forever, so the queue moves
 * on when the task settles or `capMs` after it started, whichever comes
 * first. A capped task keeps running and its caller still gets the real
 * result; `onCap` is called once (default: console.warn, since this module
 * must not import the logger).
 */
export const KEYED_QUEUE_TASK_CAP_MS = 60_000

export interface KeyedQueueOptions {
  capMs?: number
  onCap?: (key: string, capMs: number) => void
}

function warnCapped(key: string, capMs: number): void {
  console.warn(`keyed queue: task for key=${key} still running after ${capMs}ms; running the next queued task`)
}

export function createKeyedQueue(opts: KeyedQueueOptions = {}) {
  const capMs = opts.capMs ?? KEYED_QUEUE_TASK_CAP_MS
  const onCap = opts.onCap ?? warnCapped
  const tails = new Map<string, Promise<void>>()
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve()
      const result = prev.then(task)
      const tail = prev.then(() => new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          resolve()
          try { onCap(key, capMs) } catch { /* a reporting failure must not block the key */ }
        }, capMs)
        const settle = () => { clearTimeout(timer); resolve() }
        result.then(settle, settle)
      }))
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return result
    },
    /** Number of keys with queued or running work (for tests). */
    pendingKeys(): number {
      return tails.size
    },
  }
}

export const MAX_DELETE_ATTEMPTS = 5

/**
 * After a failed delete: retry (re-arm cleanup) until `max` failed attempts,
 * then give up once (alert the owner). The DB row survives either way, so the
 * next boot's reconciler retries.
 */
export function planDeleteRetry(failedAttempts: number, max = MAX_DELETE_ATTEMPTS): 'retry' | 'give_up' {
  return failedAttempts < max ? 'retry' : 'give_up'
}
