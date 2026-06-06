/**
 * Scheduled-post lifecycle: posting, claiming due rows, send-now, and the
 * re-render used by the RSVP buttons. The DB row is the source of truth — the
 * old `/sudo → Game Night` flow kept RSVP state in memory and lost it on
 * restart; everything here round-trips through Postgres.
 */
import { and, eq, isNotNull, lt, lte, or } from 'drizzle-orm'
import type { Channel, Client } from 'discord.js'
import { db } from '../../db/client'
import { scheduledPosts, type ScheduledPostRow } from '../../db/schema/scheduledPosts'
import { logger } from '../logger'
import { buildScheduledPostPayload } from './gameNight'

/** Treat a 'posting' row older than this as crashed mid-post and reclaim it. */
const STALE_POSTING_MS = 2 * 60_000

async function fetchSendableChannel(client: Client, channelId: string): Promise<Channel | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null)
  if (!channel || !channel.isTextBased() || !('send' in channel)) return null
  return channel
}

export interface PostOutcome {
  ok: boolean
  messageId?: string
  channelId?: string
  error?: string
}

/**
 * Render + send a single row, then persist the result. Safe to call from the
 * scheduler (after a claim) or directly from the send-now verb.
 */
export async function postScheduledPostRow(client: Client, row: ScheduledPostRow): Promise<PostOutcome> {
  try {
    const channel = await fetchSendableChannel(client, row.channelId)
    if (!channel) {
      await markFailed(row.id, 'channel-unreachable')
      return { ok: false, error: 'channel-unreachable' }
    }

    const payload = buildScheduledPostPayload(row)
    if (payload.components.length === 0) {
      await markFailed(row.id, 'empty-spec')
      return { ok: false, error: 'empty-spec' }
    }

    const sent = await (channel as unknown as { send: (p: unknown) => Promise<{ id: string }> }).send(payload)

    await db
      .update(scheduledPosts)
      .set({ status: 'posted', messageId: sent.id, postedAt: new Date(), error: null, updatedAt: new Date() })
      .where(eq(scheduledPosts.id, row.id))

    logger.info(`scheduledPost posted id=${row.id} kind=${row.kind} channel=${row.channelId} message=${sent.id}`)
    return { ok: true, messageId: sent.id, channelId: row.channelId }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`scheduledPost post failed id=${row.id}: ${msg}`)
    await markFailed(row.id, msg.slice(0, 500))
    return { ok: false, error: 'discord-error' }
  }
}

async function markFailed(id: string, error: string): Promise<void> {
  await db
    .update(scheduledPosts)
    .set({ status: 'failed', error, updatedAt: new Date() })
    .where(eq(scheduledPosts.id, id))
    .catch(() => {})
}

/**
 * Post a specific row immediately (send-now). Loads the row, refuses if it was
 * already posted, otherwise posts and returns the outcome.
 */
export async function sendScheduledPostNow(client: Client, id: string): Promise<PostOutcome> {
  const [row] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id))
  if (!row) return { ok: false, error: 'not-found' }
  if (row.status === 'posted') return { ok: false, error: 'already-posted' }
  if (row.status === 'canceled') return { ok: false, error: 'canceled' }
  return postScheduledPostRow(client, row)
}

/**
 * Atomically claim every due row (status='scheduled' & fire_at<=now) plus any
 * stale 'posting' rows left behind by a crash, flipping them to 'posting' so a
 * second tick can't double-post, and return them for sending.
 */
async function claimDuePosts(): Promise<ScheduledPostRow[]> {
  const now = new Date()
  const staleCutoff = new Date(now.getTime() - STALE_POSTING_MS)
  return db
    .update(scheduledPosts)
    .set({ status: 'posting', updatedAt: now })
    .where(
      and(
        isNotNull(scheduledPosts.fireAt),
        or(
          and(eq(scheduledPosts.status, 'scheduled'), lte(scheduledPosts.fireAt, now)),
          and(eq(scheduledPosts.status, 'posting'), lt(scheduledPosts.updatedAt, staleCutoff)),
        ),
      ),
    )
    .returning()
}

let ticking = false

/** One scheduler tick — claim due rows and post them. Never throws. */
export async function runScheduledPostTick(client: Client): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const due = await claimDuePosts()
    for (const row of due) {
      await postScheduledPostRow(client, row)
    }
  } catch (err) {
    logger.warn(`scheduledPost tick error: ${(err as Error)?.message}`)
  } finally {
    ticking = false
  }
}

/** Reload a row and re-render its message in place (used by RSVP toggles). */
export async function rerenderScheduledPost(client: Client, id: string): Promise<void> {
  const [row] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id))
  if (!row || !row.messageId) return
  const channel = await fetchSendableChannel(client, row.channelId)
  if (!channel) return
  const msg = await (channel as unknown as { messages: { fetch: (id: string) => Promise<{ edit: (p: unknown) => Promise<unknown> }> } }).messages
    .fetch(row.messageId)
    .catch(() => null)
  if (!msg) return
  const payload = buildScheduledPostPayload(row)
  await msg.edit(payload).catch((err: unknown) => {
    logger.warn(`scheduledPost rerender failed id=${id}: ${(err as Error)?.message}`)
  })
}
