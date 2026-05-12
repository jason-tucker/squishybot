/**
 * `hub.lockdown_all` verb — guild-wide lock / unlock for every hub.
 *
 * Params: `{ locked: boolean, durationMinutes?: number }`.
 *
 *  - `locked: true`  → `lockAllHubs(client, guildId, until)`. Stamps
 *    `voice.guild_lockdown_until` so the policy survives a bot restart.
 *  - `locked: false` → `unlockAllHubs(client, guildId)`. Per-hub
 *    individual lockdowns that are still active are preserved by the
 *    underlying service.
 *
 * Returns `{ok: true, data: {count}}` where `count` is the number of
 * hub rows the panel can expect the change to apply to (read from
 * the bot's in-memory cache so the panel sees the same shape regardless
 * of DB latency).
 */
import { registerVerb, type VerbHandler } from '../../registry'
import { env } from '../../../../config/env'
import { lockAllHubs, unlockAllHubs } from '../../../voice/hubLockdown'
import { listHubs } from '../../../settings'

const DEFAULT_DURATION_MINUTES = 1440 // 24h
const MAX_DURATION_MINUTES = 60 * 24 * 30 // 30 days

export const hubLockdownAllHandler: VerbHandler = async (params, ctx) => {
  if (!params || typeof params !== 'object') {
    return { ok: false, error: 'invalid-params', details: 'expected object' }
  }
  const p = params as { locked?: unknown; durationMinutes?: unknown }

  if (typeof p.locked !== 'boolean') {
    return { ok: false, error: 'invalid-locked', details: 'expected boolean' }
  }

  const count = listHubs().filter(h => h.guildId === env.GUILD_ID).length

  if (p.locked) {
    let mins = DEFAULT_DURATION_MINUTES
    if (p.durationMinutes !== undefined && p.durationMinutes !== null) {
      if (
        typeof p.durationMinutes !== 'number' ||
        !Number.isFinite(p.durationMinutes) ||
        !Number.isInteger(p.durationMinutes) ||
        p.durationMinutes <= 0 ||
        p.durationMinutes > MAX_DURATION_MINUTES
      ) {
        return { ok: false, error: 'invalid-durationMinutes' }
      }
      mins = p.durationMinutes
    }
    const until = new Date(Date.now() + mins * 60_000)
    await lockAllHubs(ctx.client, env.GUILD_ID, until)
    return { ok: true, data: { count, until: until.toISOString() } }
  } else {
    await unlockAllHubs(ctx.client, env.GUILD_ID)
    return { ok: true, data: { count } }
  }
}

registerVerb('hub.lockdown_all', hubLockdownAllHandler)
