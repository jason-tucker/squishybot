/**
 * `cmd.squishy.rxnroles.expire` — manual expiry of a reaction-role
 * message. Same teardown as `rxnroles.delete`, but tagged with
 * `action:'expired'` in the bot's log line so operator forensics can tell
 * "I (panel) clicked delete" from "I (panel) forced an early expiry".
 *
 * Useful when the temporary-mode timer is too far off and an operator
 * wants the cleanup to fire now — calling `delete` would technically
 * work, but `expire` keeps the audit trail honest about intent.
 *
 * Params: `{ messageId: string }`. Returns the same shape as
 * `rxnroles.delete`: `{ ok: true }` or `{ ok: false, error: '<code>' }`.
 */
import { registerVerb, type VerbHandler } from '../../registry'
import {
  deleteReactionRoleMessage,
  getReactionRoleConfig,
} from '../../../reactionRoles'
import { logger } from '../../../logger'

interface ExpireParams {
  messageId: string
}

function parseParams(raw: unknown): ExpireParams | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'bad-params' }
  const o = raw as Record<string, unknown>
  const messageId = typeof o.messageId === 'string' ? o.messageId.trim() : ''
  if (!/^\d{15,25}$/.test(messageId)) return { error: 'bad-params' }
  return { messageId }
}

export const rxnRolesExpireHandler: VerbHandler = async (params, ctx) => {
  const parsed = parseParams(params)
  if ('error' in parsed) return { ok: false, error: parsed.error }

  const cfg = getReactionRoleConfig(parsed.messageId)
  if (!cfg) {
    return { ok: false, error: 'not-found' }
  }

  try {
    await deleteReactionRoleMessage(ctx.client, parsed.messageId)
    logger.info(
      `rxnroles action:'expired' messageId=${parsed.messageId} channelId=${cfg.channelId}`,
    )
    return { ok: true }
  } catch (err) {
    const msg = (err as Error).message
    logger.warn(`rxnroles.expire failed for ${parsed.messageId}: ${msg}`)
    return { ok: false, error: 'delete-failed', details: msg }
  }
}

registerVerb('rxnroles.expire', rxnRolesExpireHandler)
