/**
 * `cmd.squishy.selfassign.remove` — remove an entry from the self-assign board
 * and delete its Discord message (if any).
 *
 * Params: { id: string }
 * Returns: { ok: true }
 *          { ok: false, error: 'bad-params' }
 */
import { registerVerb, type VerbHandler } from '../../registry'
import { getEntry, removeEntry, deleteEntryMessage } from '../../../selfAssign'

const removeHandler: VerbHandler = async (params, ctx) => {
  if (!params || typeof params !== 'object') return { ok: false, error: 'bad-params' }
  const o = params as Record<string, unknown>

  const id = typeof o.id === 'string' ? o.id.trim() : ''
  if (!id) return { ok: false, error: 'bad-params' }

  const entry = getEntry(id)
  if (entry) {
    await deleteEntryMessage(ctx.client, entry)
  }
  await removeEntry(id)

  return { ok: true }
}

registerVerb('selfassign.remove', removeHandler)
