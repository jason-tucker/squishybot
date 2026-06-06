/**
 * `scheduled_post.cancel` RPC verb — remove a posted scheduled message.
 *
 * Called by the panel when a sudo deletes a *live* scheduled post so the
 * Discord message (with its now-dead RSVP buttons) doesn't linger. Best-effort
 * on the Discord side; the row is marked 'canceled' regardless (the panel may
 * delete the row right after — that's fine, this is idempotent).
 *
 * Params: { id: string }
 * Reply:  { ok: true, data: { deleted: boolean } } | { ok: false, error }
 */
import { eq } from 'drizzle-orm'
import { registerVerb, type VerbHandler } from '../../registry'
import { db } from '../../../../db/client'
import { scheduledPosts } from '../../../../db/schema/scheduledPosts'
import { logger } from '../../../logger'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const cancelHandler: VerbHandler = async (params, ctx) => {
  const id =
    params && typeof params === 'object' && typeof (params as { id?: unknown }).id === 'string'
      ? (params as { id: string }).id.trim()
      : ''
  if (!UUID_RE.test(id)) return { ok: false, error: 'invalid-params' }

  const [row] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, id))
  if (!row) return { ok: false, error: 'not-found' }

  let deleted = false
  if (row.messageId) {
    try {
      const channel = await ctx.client.channels.fetch(row.channelId).catch(() => null)
      if (channel && channel.isTextBased() && 'messages' in channel) {
        const msg = await (channel as unknown as { messages: { fetch: (id: string) => Promise<{ delete: () => Promise<unknown> }> } }).messages
          .fetch(row.messageId)
          .catch(() => null)
        if (msg) {
          await msg.delete()
          deleted = true
        }
      }
    } catch (err) {
      logger.warn(`scheduled_post.cancel: discord delete failed id=${id}: ${(err as Error)?.message}`)
    }
  }

  await db
    .update(scheduledPosts)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(eq(scheduledPosts.id, id))
    .catch(() => {})

  return { ok: true, data: { deleted } }
}

registerVerb('scheduled_post.cancel', cancelHandler)
