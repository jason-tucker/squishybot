/**
 * `voice.disconnect` — kick a user out of the auto voice channel.
 *
 * Params: `{ voiceChannelId: string, userId: string }`.
 *
 * Sets the target member's voice channel to `null` (Discord's "disconnect").
 * Only takes effect if the user is currently in the target VC; otherwise
 * Discord silently no-ops (the member edit still succeeds at the API level
 * but doesn't move them out of a different VC — we treat that as success,
 * since the panel just wanted them not-in-this-VC).
 *
 * Permission validation is enforced by the panel side before this verb is
 * called (`canControlChannel` in the API route). The bot itself trusts the
 * RPC envelope (HMAC + replay guard) — the only authorization layer here
 * is "the message survived the envelope check."
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { registerVerb, type VerbHandler } from '../../registry'
import { db } from '../../../../db/client'
import { autoChannels } from '../../../../db/schema'
import { logger } from '../../../logger'

const Schema = z.object({
  voiceChannelId: z.string().min(1),
  userId: z.string().min(1),
})

export const disconnectHandler: VerbHandler = async (params, ctx) => {
  const parsed = Schema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, error: 'invalid-params', details: parsed.error.flatten() }
  }
  const { voiceChannelId, userId } = parsed.data

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) {
    return { ok: false, error: 'channel-not-found' }
  }

  const guild = ctx.client.guilds.cache.get(record.guildId)
  if (!guild) {
    return { ok: false, error: 'guild-not-found' }
  }

  try {
    const member = await guild.members.fetch(userId).catch(() => null)
    if (!member) {
      return { ok: false, error: 'member-not-found' }
    }

    // Only disconnect if they're currently in this specific VC — otherwise
    // we'd risk yanking someone out of an unrelated room.
    if (member.voice.channelId !== voiceChannelId) {
      return { ok: false, error: 'member-not-in-channel' }
    }

    await member.voice.setChannel(null, 'Disconnected via botpanel')
    return { ok: true, data: { userId } }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`voice.disconnect: discord error for vc=${voiceChannelId} user=${userId}: ${msg}`)
    return { ok: false, error: 'discord-error', details: msg }
  }
}

registerVerb('voice.disconnect', disconnectHandler)
