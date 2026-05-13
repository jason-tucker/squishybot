/**
 * `games.set_prefs` — batched per-user game-prefs write driven by the panel's
 * `/me/games` page.
 *
 * Mirrors the `/games` slash flow's per-game toggle exactly: every individual
 * write goes through `setPref()` in `src/services/games.ts`, which is the same
 * helper `interactions/gamesEditor.ts` calls from the in-bot button handler.
 * That means role grants, channel-overwrite edits, the "view required for
 * ping" rule, the cascade-off-when-view-disabled side effect, and the audit
 * row shape all match — there is no duplicated logic on this side.
 *
 * Params:
 *   { userId: snowflake, prefs: [{ gameId: uuid, view: bool, ping: bool }] }
 *
 * Per-row semantics: we apply VIEW first, then PING, so the "ping requires
 * view" guard the underlying `setPref()` enforces never fails for the request
 * we just wrote. A `setPref()` with an unknown gameId errors per-row rather
 * than failing the whole batch — operator gets `{applied, skipped, errors}`
 * back so the panel can render a "3 applied, 1 unknown game" toast.
 *
 * Side-effect registration on import — wired into the boot path next to the
 * existing wave-7b games imports in `src/bot/events/ready.ts`.
 */
import { registerVerb, type VerbHandler } from '../../registry'
import { env } from '../../../../config/env'
import { logger } from '../../../logger'
import { getGame, setPref } from '../../../games'

type PrefRow = {
  gameId: string
  view: boolean
  ping: boolean
}

type SetPrefsParams = {
  userId: string
  prefs: PrefRow[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isPrefRow(v: unknown): v is PrefRow {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r.gameId === 'string'
      && UUID_RE.test(r.gameId)
      && typeof r.view === 'boolean'
      && typeof r.ping === 'boolean'
}

function isSetPrefsParams(v: unknown): v is SetPrefsParams {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  if (typeof p.userId !== 'string' || p.userId.length === 0) return false
  if (!Array.isArray(p.prefs)) return false
  // Allow an empty array — a panel save with no game rows toggled is a no-op
  // success rather than a 400.
  return p.prefs.every(isPrefRow)
}

export const gamesSetPrefsHandler: VerbHandler = async (params, ctx) => {
  if (!isSetPrefsParams(params)) {
    return { ok: false, error: 'bad-params', details: 'expected { userId, prefs: [{gameId, view, ping}] }' }
  }

  const guild = ctx.client.guilds.cache.get(env.GUILD_ID)
    ?? await ctx.client.guilds.fetch(env.GUILD_ID).catch(() => null)
  if (!guild) {
    return { ok: false, error: 'guild-unavailable', details: env.GUILD_ID }
  }

  const member = await guild.members.fetch(params.userId).catch(() => null)
  if (!member) {
    return { ok: false, error: 'user-not-found', details: params.userId }
  }

  let applied = 0
  let skipped = 0
  const errors: Array<{ gameId: string; reason: string }> = []

  for (const row of params.prefs) {
    // Validate the gameId actually exists in the catalog first — skip with a
    // per-row error rather than rejecting the whole batch (panel may have a
    // stale games list).
    if (!getGame(row.gameId)) {
      skipped++
      errors.push({ gameId: row.gameId, reason: 'game-not-found' })
      continue
    }

    // Apply view first so the ping write (which requires view=true) doesn't
    // trip the underlying "view-required-for-ping" guard mid-batch.
    const viewResult = await setPref(member, row.gameId, 'view', row.view, {
      editorDiscordId: params.userId,
      mode: 'self',
    })
    if (!viewResult.ok) {
      errors.push({ gameId: row.gameId, reason: viewResult.reason })
      continue
    }

    const pingResult = await setPref(member, row.gameId, 'ping', row.ping, {
      editorDiscordId: params.userId,
      mode: 'self',
    })
    if (!pingResult.ok) {
      // Special-case: requesting ping=true with view=false is a per-row error,
      // not an applied write. The view write above already succeeded so the
      // row's view state is correct; only the ping side is rejected.
      errors.push({ gameId: row.gameId, reason: pingResult.reason })
      continue
    }

    applied++
  }

  logger.info(`games.set_prefs: user=${params.userId} applied=${applied} skipped=${skipped} errors=${errors.length}`)
  return { ok: true, data: { applied, skipped, errors } }
}

registerVerb('games.set_prefs', gamesSetPrefsHandler)
