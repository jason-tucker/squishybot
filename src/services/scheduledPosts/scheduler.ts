/**
 * Tick-based scheduler for `scheduled_posts`. Polls every 15s for rows whose
 * `fire_at` has passed and posts them. Lightweight (one indexed UPDATE …
 * RETURNING per tick); single bot process, so no distributed locking needed —
 * the atomic status='posting' claim in `claimDuePosts` guards against the
 * unlikely overlapping-tick case.
 */
import type { Client } from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { scheduledPosts } from '../../db/schema/scheduledPosts'
import { logger } from '../logger'
import { runScheduledPostTick } from './service'

const TICK_MS = 15_000

let started = false

/** Reset rows wedged in 'posting' (crash mid-post) back to 'scheduled'. */
async function resetStalePosting(): Promise<void> {
  await db
    .update(scheduledPosts)
    .set({ status: 'scheduled', updatedAt: new Date() })
    .where(eq(scheduledPosts.status, 'posting'))
    .catch((err) => logger.warn(`scheduledPost reset-stale failed: ${(err as Error)?.message}`))
}

export function startScheduledPostScheduler(client: Client): void {
  if (started) return
  started = true

  void resetStalePosting().then(() => {
    // Kick one tick shortly after boot so a post that came due while the bot
    // was down fires promptly instead of waiting a full interval.
    setTimeout(() => void runScheduledPostTick(client), 3_000)
  })

  setInterval(() => void runScheduledPostTick(client), TICK_MS)
  logger.info(`scheduledPost scheduler started (every ${TICK_MS / 1000}s)`)
}
