/**
 * `play.post` RPC verb — panel-triggered LFG post.
 *
 * Mirrors the `/play <game> [message] [ping]` slash command but lets the
 * panel drive it. Same gates, same Components V2 panel, same Help / Notify
 * Toggle buttons. Cooldown is enforced by default (panel routes can
 * override only by passing `enforceCooldown: false` — typically reserved
 * for sudo-from-panel flows; the existing slash command path bypasses for
 * `isSudo(member)`, but RPC has no member context, so the cooldown
 * decision lives with the caller).
 *
 * Params:
 *   { gameId: string, hostUserId: string, message?: string,
 *     ping?: boolean, enforceCooldown?: boolean }
 *
 * Reply:
 *   { ok: true, data: { channelId, messageId } } — success
 *   { ok: false, error: <token>, details? } — see `PostLfgResult.error`
 *     for the union of tokens. `invalid-params` and `game-not-found` are
 *     thrown only here; everything else comes from `postLfg()` directly.
 */
import { registerVerb, type VerbHandler } from '../registry'
import { postLfg } from '../../../commands/play'
import { getGame } from '../../games'

type PlayPostParams = {
  gameId: string
  hostUserId: string
  message?: string
  ping?: boolean
  enforceCooldown?: boolean
}

function isPlayPostParams(v: unknown): v is PlayPostParams {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  if (typeof p.gameId !== 'string' || p.gameId.length === 0) return false
  if (typeof p.hostUserId !== 'string' || p.hostUserId.length === 0) return false
  if (p.message !== undefined && typeof p.message !== 'string') return false
  if (p.ping !== undefined && typeof p.ping !== 'boolean') return false
  if (p.enforceCooldown !== undefined && typeof p.enforceCooldown !== 'boolean') return false
  return true
}

const MAX_MESSAGE_LEN = 500

export const playPostHandler: VerbHandler = async (params, ctx) => {
  if (!isPlayPostParams(params)) {
    return { ok: false, error: 'invalid-params' }
  }
  const game = getGame(params.gameId)
  if (!game) {
    return { ok: false, error: 'game-not-found', details: params.gameId }
  }
  const message = params.message?.trim()
  if (message && message.length > MAX_MESSAGE_LEN) {
    return { ok: false, error: 'message-too-long', details: `max ${MAX_MESSAGE_LEN} chars` }
  }
  const result = await postLfg(ctx.client, {
    game,
    hostUserId: params.hostUserId,
    hostMessage: message || undefined,
    ping: params.ping,
    // Default true — the slash command bypasses for sudo, but RPC has no
    // member context, so the caller decides. Panel route default is to
    // enforce so spam-clicking the panel button can't bypass the cooldown
    // any easier than running /play repeatedly.
    enforceCooldown: params.enforceCooldown ?? true,
  })
  if (result.ok) {
    return { ok: true, data: { channelId: result.channelId, messageId: result.messageId } }
  }
  return {
    ok: false,
    error: result.error,
    details: result.details,
    // Surface remainingSec for cooldown so the panel can show a sensible message.
    ...(result.error === 'cooldown' && result.remainingSec !== undefined
      ? { remainingSec: result.remainingSec }
      : {}),
  }
}

registerVerb('play.post', playPostHandler)
