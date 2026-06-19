/**
 * `cmd.squishy.selfassign.add` — add an entry to the self-assign board.
 *
 * Params: { kind: 'role'|'game', refId: string, label?: string|null,
 *            description?: string|null, emoji?: string|null }
 * Returns: { ok: true, data: { id: string } }
 *          { ok: false, error: 'bad-params'|'bad-role'|'game-not-found'|'already-added'|'guild-unavailable' }
 */
import { registerVerb, type VerbHandler } from '../../registry'
import {
  findEntryByRef,
  addEntry,
  getChannelId,
  postOrUpdateEntry,
} from '../../../selfAssign'
import { getGame } from '../../../games'
import { checkAssignableRole } from '../../../../utils/roleGuard'
import { env } from '../../../../config/env'

const SNOWFLAKE_RE = /^\d{15,25}$/

const addHandler: VerbHandler = async (params, ctx) => {
  if (!params || typeof params !== 'object') return { ok: false, error: 'bad-params' }
  const o = params as Record<string, unknown>

  const kind = typeof o.kind === 'string' ? o.kind : ''
  if (kind !== 'role' && kind !== 'game') return { ok: false, error: 'bad-params' }

  const refId = typeof o.refId === 'string' ? o.refId.trim() : ''
  if (!refId) return { ok: false, error: 'bad-params' }

  const label = typeof o.label === 'string' ? o.label : null
  const description = typeof o.description === 'string' ? o.description : null
  const emoji = typeof o.emoji === 'string' ? o.emoji : null

  const guild = ctx.client.guilds.cache.get(env.GUILD_ID)
  if (!guild) return { ok: false, error: 'guild-unavailable' }

  if (kind === 'role') {
    if (!SNOWFLAKE_RE.test(refId)) return { ok: false, error: 'bad-params' }
    const verdict = checkAssignableRole(guild, refId)
    if (!verdict.ok) return { ok: false, error: 'bad-role', details: verdict.reason }
  } else {
    // kind === 'game'
    const game = getGame(refId)
    if (!game) return { ok: false, error: 'game-not-found' }
  }

  if (findEntryByRef(kind, refId)) return { ok: false, error: 'already-added' }

  const entry = await addEntry({ kind, refId, label, description, emoji })
  const channelId = getChannelId()
  if (channelId) {
    await postOrUpdateEntry(ctx.client, guild, channelId, entry)
  }

  return { ok: true, data: { id: entry.id } }
}

registerVerb('selfassign.add', addHandler)
