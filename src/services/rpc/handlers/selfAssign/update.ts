/**
 * `cmd.squishy.selfassign.update` — edit label/description/emoji/enabled on an entry
 * and reflect the change in Discord immediately.
 *
 * Params: { id: string, label?: string|null, description?: string|null,
 *            emoji?: string|null, enabled?: boolean }
 * Returns: { ok: true }
 *          { ok: false, error: 'bad-params'|'not-found'|'guild-unavailable' }
 */
import { registerVerb, type VerbHandler } from '../../registry'
import {
  updateEntry,
  getChannelId,
  postOrUpdateEntry,
  deleteEntryMessage,
} from '../../../selfAssign'
import { env } from '../../../../config/env'

const updateHandler: VerbHandler = async (params, ctx) => {
  if (!params || typeof params !== 'object') return { ok: false, error: 'bad-params' }
  const o = params as Record<string, unknown>

  const id = typeof o.id === 'string' ? o.id.trim() : ''
  if (!id) return { ok: false, error: 'bad-params' }

  const patch: {
    label?: string | null
    description?: string | null
    emoji?: string | null
    enabled?: boolean
  } = {}
  if ('label' in o) patch.label = typeof o.label === 'string' ? o.label : null
  if ('description' in o) patch.description = typeof o.description === 'string' ? o.description : null
  if ('emoji' in o) patch.emoji = typeof o.emoji === 'string' ? o.emoji : null
  if ('enabled' in o) patch.enabled = Boolean(o.enabled)

  const guild = ctx.client.guilds.cache.get(env.GUILD_ID)
  if (!guild) return { ok: false, error: 'guild-unavailable' }

  const row = await updateEntry(id, patch)
  if (!row) return { ok: false, error: 'not-found' }

  const channelId = getChannelId()
  if (channelId) {
    if (row.enabled) {
      await postOrUpdateEntry(ctx.client, guild, channelId, row)
    } else {
      await deleteEntryMessage(ctx.client, row)
    }
  }

  return { ok: true }
}

registerVerb('selfassign.update', updateHandler)
