/**
 * `report.submit` — RPC verb that mirrors the `/report` slash modal.
 *
 * The panel's `/report` page POSTs Title / Type / Description / Steps into a
 * route that calls this verb on the requesting user's behalf. The DM-the-
 * owner + GitHub-issue-on-approval flow is the bot's responsibility and is
 * shared with the in-bot path via `reportRequestService.submitReport()`.
 *
 * Params:
 *   { userId: snowflake, title: string, type: string,
 *     description: string, steps?: string }
 *
 * Returns the underlying service result on success:
 *   { ok: true, data: { sessionKey, ownerNotified: true } }
 *
 * On failure returns the service's machine-token error so the panel can
 * render the right toast — `not-configured`, `owner-unset`, `missing-fields`,
 * `owner-dm-failed`. Bad params shape errors as `bad-params` before we ever
 * call the service.
 */
import { registerVerb, type VerbHandler } from '../registry'
import { submitReport } from '../../reportRequestService'

type ReportSubmitParams = {
  userId: string
  title: string
  type: string
  description: string
  steps?: string
}

function isReportSubmitParams(v: unknown): v is ReportSubmitParams {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  if (typeof p.userId !== 'string' || p.userId.length === 0) return false
  if (typeof p.title !== 'string') return false
  if (typeof p.type !== 'string') return false
  if (typeof p.description !== 'string') return false
  if (p.steps !== undefined && typeof p.steps !== 'string') return false
  return true
}

export const reportSubmitHandler: VerbHandler = async (params, ctx) => {
  if (!isReportSubmitParams(params)) {
    return {
      ok: false,
      error: 'bad-params',
      details: 'expected { userId, title, type, description, steps? }',
    }
  }

  const result = await submitReport({
    client: ctx.client,
    userId: params.userId,
    title: params.title,
    type: params.type,
    description: params.description,
    steps: params.steps,
  })

  if (!result.ok) {
    return { ok: false, error: result.error, details: result.details }
  }
  return {
    ok: true,
    data: { sessionKey: result.sessionKey, ownerNotified: result.ownerNotified },
  }
}

registerVerb('report.submit', reportSubmitHandler)
