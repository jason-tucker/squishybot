/**
 * `cmd.squishy.selfassign.reorder` — set a new sort order for all entries,
 * then re-publish the board so the channel reflects the new order.
 *
 * Params: { ids: string[] }  — full ordered list of entry UUIDs.
 * Returns: { ok: true }
 *          { ok: false, error: 'bad-params' }
 */
import { registerVerb, type VerbHandler } from '../../registry'
import { reorderEntries, publishBoard } from '../../../selfAssign'
import { env } from '../../../../config/env'

const reorderHandler: VerbHandler = async (params, ctx) => {
  if (!params || typeof params !== 'object') return { ok: false, error: 'bad-params' }
  const o = params as Record<string, unknown>

  if (!Array.isArray(o.ids) || o.ids.some(i => typeof i !== 'string')) {
    return { ok: false, error: 'bad-params' }
  }
  const ids = (o.ids as string[]).map(i => i.trim()).filter(Boolean)

  await reorderEntries(ids)
  await publishBoard(ctx.client, env.GUILD_ID)

  return { ok: true }
}

registerVerb('selfassign.reorder', reorderHandler)
