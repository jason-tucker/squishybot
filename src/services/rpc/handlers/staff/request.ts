/**
 * `staff.request` — panel-side self-service "Request a staff role".
 *
 * Params: { userId, departmentSlug?, tierSlug?, realName? }
 *   - At least one of departmentSlug / tierSlug must be present (the bot
 *     rejects empty requests with `no-selection`).
 *   - `userId` is the requester's snowflake. The panel route validates
 *     `userId` matches the authenticated session before publishing;
 *     RPC is a privileged channel.
 *
 * Routes through `staffRequestService.submitStaffRequest` so this verb
 * and the bot's slash flow stay byte-identical.
 */
import { registerVerb, type VerbResult } from '../../registry'
import { submitStaffRequest } from '../../../staffRequestService'

const SNOWFLAKE = /^\d{15,25}$/
const SLUG = /^[a-z0-9_]+$/

registerVerb('staff.request', async (rawParams, ctx): Promise<VerbResult> => {
  const params = rawParams as
    | {
        userId?: unknown
        departmentSlug?: unknown
        tierSlug?: unknown
        realName?: unknown
      }
    | null
  if (!params || typeof params !== 'object') {
    return { ok: false, error: 'invalid-params' }
  }

  const userId = params.userId
  if (typeof userId !== 'string' || !SNOWFLAKE.test(userId)) {
    return { ok: false, error: 'bad-user-id' }
  }

  const departmentSlug =
    typeof params.departmentSlug === 'string' && params.departmentSlug.length > 0
      ? params.departmentSlug
      : null
  const tierSlug =
    typeof params.tierSlug === 'string' && params.tierSlug.length > 0 ? params.tierSlug : null

  if (departmentSlug !== null && (!SLUG.test(departmentSlug) || departmentSlug.length > 32)) {
    return { ok: false, error: 'bad-department-slug' }
  }
  if (tierSlug !== null && (!SLUG.test(tierSlug) || tierSlug.length > 32)) {
    return { ok: false, error: 'bad-tier-slug' }
  }

  const realName = typeof params.realName === 'string' ? params.realName : null
  if (realName !== null && realName.length > 120) return { ok: false, error: 'real-name-too-long' }

  const result = await submitStaffRequest({
    client: ctx.client,
    userId,
    departmentSlug,
    tierSlug,
    realName,
  })

  if (!result.ok) {
    return { ok: false, error: result.error, details: result.details }
  }

  return {
    ok: true,
    data: {
      approvalId: result.approvalId,
      approvalMsgId: result.approvalMsgId,
      departmentLabel: result.departmentLabel,
      tierLabel: result.tierLabel,
    },
  }
})
