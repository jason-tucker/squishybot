/**
 * `scheduled_post.send` RPC verb — post a stored scheduled post immediately.
 *
 * The panel writes the row to Postgres directly (Drizzle), then calls this for
 * the "Send now" button so it gets instant feedback (channel + message id)
 * instead of waiting for the next scheduler tick. Future-dated rows are left to
 * the scheduler.
 *
 * Params: { id: string }  (uuid of the scheduled_posts row)
 * Reply:  { ok: true, data: { channelId, messageId } }
 *         { ok: false, error: 'invalid-params' | 'not-found' | 'already-posted'
 *                            | 'canceled' | 'channel-unreachable' | 'empty-spec'
 *                            | 'discord-error' }
 */
import { registerVerb, type VerbHandler } from '../../registry'
import { sendScheduledPostNow } from '../../../scheduledPosts/service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const sendHandler: VerbHandler = async (params, ctx) => {
  const id =
    params && typeof params === 'object' && typeof (params as { id?: unknown }).id === 'string'
      ? (params as { id: string }).id.trim()
      : ''
  if (!UUID_RE.test(id)) {
    return { ok: false, error: 'invalid-params' }
  }
  const result = await sendScheduledPostNow(ctx.client, id)
  if (result.ok) {
    return { ok: true, data: { channelId: result.channelId, messageId: result.messageId } }
  }
  return { ok: false, error: result.error ?? 'discord-error' }
}

registerVerb('scheduled_post.send', sendHandler)
