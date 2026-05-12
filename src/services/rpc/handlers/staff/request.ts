/**
 * `staff.request` — panel-side self-service "Request a staff role".
 *
 * Mirrors what the `/settings → Staff Role` modal does on the bot:
 * inserts a `staff_approvals` row and posts the approval card to the
 * configured thread. Centralized in `staffRequestService.ts` so the
 * panel path and the modal path produce byte-identical Discord output.
 *
 * Params: { userId, slug, realName?, reason? }
 *   - `userId` is the requester's snowflake. The panel route validates
 *     that `userId` matches the authenticated session before publishing
 *     this verb (a sudo could otherwise impersonate). We don't repeat
 *     that check here — RPC is a privileged channel, the panel is the
 *     authorization boundary.
 */
import { registerVerb, type VerbResult } from '../../registry'
import { submitStaffRequest } from '../../../staffRequestService'

const SNOWFLAKE = /^\d{15,25}$/
const SLUG = /^[a-z0-9_]+$/

registerVerb('staff.request', async (rawParams, ctx): Promise<VerbResult> => {
  const params = rawParams as
    | { userId?: unknown; slug?: unknown; realName?: unknown; reason?: unknown }
    | null
  if (!params || typeof params !== 'object') {
    return { ok: false, error: 'invalid-params' }
  }

  const userId = params.userId
  const slug = params.slug
  if (typeof userId !== 'string' || !SNOWFLAKE.test(userId)) {
    return { ok: false, error: 'bad-user-id' }
  }
  if (typeof slug !== 'string' || !SLUG.test(slug) || slug.length > 32) {
    return { ok: false, error: 'bad-slug' }
  }

  const realName = typeof params.realName === 'string' ? params.realName : null
  const reason = typeof params.reason === 'string' ? params.reason : null
  if (realName !== null && realName.length > 120) return { ok: false, error: 'real-name-too-long' }
  if (reason !== null && reason.length > 1000) return { ok: false, error: 'reason-too-long' }

  const result = await submitStaffRequest({
    client: ctx.client,
    userId,
    slug,
    realName,
    reason,
  })

  if (!result.ok) {
    return { ok: false, error: result.error, details: result.details }
  }

  return {
    ok: true,
    data: {
      approvalId: result.approvalId,
      approvalMsgId: result.approvalMsgId,
      roleLabel: result.roleLabel,
    },
  }
})
