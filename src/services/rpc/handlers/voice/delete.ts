/**
 * `voice.delete` — tear down an auto-channel (VC + text channel + row).
 *
 * Params: `{ voiceChannelId: string }`.
 *
 * Delegates to `deleteAutoChannel` which is the same code path the in-bot
 * Delete button calls. It handles: cancelling pending timers (cleanup,
 * hide-grace, panel refresh, rename throttle, sticky debounce), deleting
 * both Discord channels, clearing the DB row + member rows, and publishing
 * the `voice.channel_deleted` event so the live panel SSE pops the card
 * out of the list immediately.
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { registerVerb, type VerbHandler } from '../../registry'
import { db } from '../../../../db/client'
import { autoChannels } from '../../../../db/schema'
import { deleteAutoChannel } from '../../../voice/autoChannel'
import { logger } from '../../../logger'

const Schema = z.object({
  voiceChannelId: z.string().min(1),
})

export const deleteHandler: VerbHandler = async (params, ctx) => {
  const parsed = Schema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, error: 'invalid-params', details: parsed.error.flatten() }
  }
  const { voiceChannelId } = parsed.data

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) {
    return { ok: false, error: 'channel-not-found' }
  }
  // Static VCs are never deleted by the bot — only their companion text channel
  // follows the cleanup lifecycle.
  if (record.sourceHubId === 'static') {
    return { ok: false, error: 'static-channel', details: 'static channels cannot be deleted' }
  }

  try {
    await deleteAutoChannel(ctx.client, record)
    return { ok: true, data: { voiceChannelId } }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`voice.delete: error for vc=${voiceChannelId}: ${msg}`)
    return { ok: false, error: 'discord-error', details: msg }
  }
}

registerVerb('voice.delete', deleteHandler)
