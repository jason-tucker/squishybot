/**
 * `hub.lockdown` verb — per-hub lock / unlock.
 *
 * Params: `{ hubChannelId: string, locked: boolean, durationMinutes?: number }`.
 *
 *  - `locked: true`  → lock the hub. `durationMinutes` controls how long;
 *    defaults to 1440 (24h), matching the longest preset on the sudo
 *    settings panel. Calls `lockHub(client, guildId, hubChannelId, until)`.
 *  - `locked: false` → immediately unlock the hub via `unlockHub`. The
 *    underlying service preserves any active guild-wide lockdown (it
 *    won't re-allow Connect while the server-wide policy is in force).
 *
 * Param validation:
 *  - `hubChannelId` is a Discord snowflake (15-25 digits).
 *  - `durationMinutes` must be a positive finite integer ≤ 30 days. We
 *    cap because a typo (e.g. 99999999) would otherwise create a
 *    timeout the JS event loop can't represent precisely.
 *
 * Guild scoping: uses the bot's configured `env.GUILD_ID` — the panel
 * doesn't pass guildId because there's exactly one. If the hub doesn't
 * belong to that guild, the underlying `applyHubConnect` call no-ops
 * silently (it looks up the channel in `client.guilds.cache.get(guildId)`).
 */
import { registerVerb, type VerbHandler } from '../../registry'
import { env } from '../../../../config/env'
import { lockHub, unlockHub } from '../../../voice/hubLockdown'

const SNOWFLAKE_RE = /^\d{15,25}$/
const DEFAULT_DURATION_MINUTES = 1440 // 24h
const MAX_DURATION_MINUTES = 60 * 24 * 30 // 30 days

export const hubLockdownHandler: VerbHandler = async (params, ctx) => {
  if (!params || typeof params !== 'object') {
    return { ok: false, error: 'invalid-params', details: 'expected object' }
  }
  const p = params as { hubChannelId?: unknown; locked?: unknown; durationMinutes?: unknown }

  const hubChannelId = typeof p.hubChannelId === 'string' ? p.hubChannelId.trim() : ''
  if (!SNOWFLAKE_RE.test(hubChannelId)) {
    return { ok: false, error: 'invalid-hubChannelId' }
  }
  if (typeof p.locked !== 'boolean') {
    return { ok: false, error: 'invalid-locked', details: 'expected boolean' }
  }

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
    await lockHub(ctx.client, env.GUILD_ID, hubChannelId, until)
    return { ok: true, data: { until: until.toISOString() } }
  } else {
    await unlockHub(ctx.client, env.GUILD_ID, hubChannelId)
    return { ok: true }
  }
}

registerVerb('hub.lockdown', hubLockdownHandler)
