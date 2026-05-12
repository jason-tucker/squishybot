/**
 * `cmd.squishy.rxnroles.delete` — tear down a reaction-role message.
 *
 * Params: `{ messageId: string }` — the Discord message ID stored in
 * `reaction_role_messages.message_id`.
 *
 * Behaviour:
 *   - Deletes the Discord message if still present (wrapped in
 *     try/catch — a 404 from a manually-deleted message is fine, we
 *     just want the DB row to follow).
 *   - Removes the `reaction_role_messages` row and (via FK / explicit
 *     delete in the service helper) the associated
 *     `reaction_role_mappings` rows.
 *   - Pops the in-memory cache entry so subsequent reactions on the
 *     (now-gone) message no-op cleanly.
 *
 * Returns `{ ok: true }` unconditionally when the row existed — the
 * Discord-side deletion is best-effort, never the gating signal. If the
 * row didn't exist we return `{ ok: false, error: 'not-found' }` so the
 * panel can show "already removed" rather than a generic success.
 */
import { registerVerb, type VerbHandler } from '../../registry'
import {
  deleteReactionRoleMessage,
  getReactionRoleConfig,
} from '../../../reactionRoles'
import { logger } from '../../../logger'

interface DeleteParams {
  messageId: string
}

function parseParams(raw: unknown): DeleteParams | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'bad-params' }
  const o = raw as Record<string, unknown>
  const messageId = typeof o.messageId === 'string' ? o.messageId.trim() : ''
  if (!/^\d{15,25}$/.test(messageId)) return { error: 'bad-params' }
  return { messageId }
}

export const rxnRolesDeleteHandler: VerbHandler = async (params, ctx) => {
  const parsed = parseParams(params)
  if ('error' in parsed) return { ok: false, error: parsed.error }

  const cfg = getReactionRoleConfig(parsed.messageId)
  if (!cfg) {
    return { ok: false, error: 'not-found' }
  }

  try {
    await deleteReactionRoleMessage(ctx.client, parsed.messageId)
    return { ok: true }
  } catch (err) {
    const msg = (err as Error).message
    logger.warn(`rxnroles.delete failed for ${parsed.messageId}: ${msg}`)
    return { ok: false, error: 'delete-failed', details: msg }
  }
}

registerVerb('rxnroles.delete', rxnRolesDeleteHandler)
