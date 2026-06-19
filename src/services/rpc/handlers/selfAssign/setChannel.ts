/**
 * `cmd.squishy.selfassign.set_channel` — set (or clear) the board's destination
 * channel, then re-publish so the new channel immediately shows the board.
 *
 * Params: { channelId: string | null }
 * Returns: { ok: true, data: { channelId: string | null } }
 *          { ok: false, error: 'bad-params'|'bad-channel'|'guild-unavailable' }
 */
import { registerVerb, type VerbHandler } from '../../registry'
import { setChannelId, publishBoard } from '../../../selfAssign'
import { env } from '../../../../config/env'

const SNOWFLAKE_RE = /^\d{15,25}$/

const setChannelHandler: VerbHandler = async (params, ctx) => {
  if (!params || typeof params !== 'object') return { ok: false, error: 'bad-params' }
  const o = params as Record<string, unknown>

  // channelId may be null (to clear) or a snowflake string.
  const rawChannelId = 'channelId' in o ? o.channelId : undefined
  if (rawChannelId !== null && typeof rawChannelId !== 'string') {
    return { ok: false, error: 'bad-params' }
  }

  const channelId = rawChannelId === null ? null : (rawChannelId as string).trim()

  const guild = ctx.client.guilds.cache.get(env.GUILD_ID)
  if (!guild) return { ok: false, error: 'guild-unavailable' }

  if (channelId !== null) {
    if (!SNOWFLAKE_RE.test(channelId)) return { ok: false, error: 'bad-channel' }
    // Validate the channel exists and is text-based.
    const ch =
      guild.channels.cache.get(channelId) ??
      (await guild.channels.fetch(channelId).catch(() => null))
    if (!ch || !ch.isTextBased()) return { ok: false, error: 'bad-channel' }
  }

  await setChannelId(channelId)
  await publishBoard(ctx.client, env.GUILD_ID)

  return { ok: true, data: { channelId } }
}

registerVerb('selfassign.set_channel', setChannelHandler)
