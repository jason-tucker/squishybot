/**
 * `voice.toggle_host` — add / remove someone from an auto-channel's host list.
 *
 * Mirrors the `/voice → Hosts` slash-select flow exactly. Both paths now go
 * through `services/voice/hostsService.ts` so behavior is byte-identical
 * (race-safe SQL update + permission sync + hidden-channel ViewChannel
 * overwrite + control-panel refresh + Redis `voice.hosts_changed` event).
 *
 * Params: `{ voiceChannelId: string, userId: string, op: 'add' | 'remove' }`
 * Reply : `{ ok: true, data: { hostUserIds: string[] } }` — fresh post-mutation
 *         array so the panel can re-render without a follow-up read.
 *
 * Auth note: the *panel route* gates manager-or-sudo on its side
 * (`require: 'sudo'` for the members-editor surface; the per-VC route
 * checks `canControlChannel` for the voice page). The verb itself is
 * privileged — RPC is HMAC-secured — so no extra auth here.
 */
import { registerVerb, type VerbResult } from '../../registry'
import { toggleHost } from '../../../voice/hostsService'

const SNOWFLAKE = /^\d{15,25}$/

registerVerb('voice.toggle_host', async (rawParams, ctx): Promise<VerbResult> => {
  const params = rawParams as
    | { voiceChannelId?: unknown; userId?: unknown; op?: unknown }
    | null
  if (!params || typeof params !== 'object') {
    return { ok: false, error: 'invalid-params' }
  }
  const voiceChannelId = params.voiceChannelId
  const userId = params.userId
  const op = params.op
  if (typeof voiceChannelId !== 'string' || !SNOWFLAKE.test(voiceChannelId)) {
    return { ok: false, error: 'bad-voice-channel-id' }
  }
  if (typeof userId !== 'string' || !SNOWFLAKE.test(userId)) {
    return { ok: false, error: 'bad-user-id' }
  }
  if (op !== 'add' && op !== 'remove') {
    return { ok: false, error: 'bad-op' }
  }

  const result = await toggleHost({
    client: ctx.client,
    voiceChannelId,
    userId,
    op,
  })
  if (!result.ok) return { ok: false, error: result.error, details: result.details }
  return { ok: true, data: result.data }
})
