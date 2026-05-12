/**
 * `users.resolve` — batch snowflake → @username + avatar lookup for the panel.
 *
 * Today panel pages render raw IDs like `117501528641634310` in audit tables,
 * staff approvals, voice rosters, etc. This verb lets the panel pre-resolve
 * those snowflakes into `{username, displayName, avatarUrl}` in a single
 * round-trip per render.
 *
 * Pure cache read — never fetches. If the bot doesn't have the user in
 * `client.users.cache` (or the member in `guild.members.cache`), the response
 * returns null fields for that id and the panel falls back to displaying the
 * raw snowflake. This keeps the verb cheap (no Discord API calls) and avoids
 * accidental large-guild pre-warm work.
 *
 * Params: `{ userIds: string[] }`
 *   - Array of Discord snowflakes. Max 100 per call. Duplicates are allowed
 *     but only resolved once (caller probably already dedup'd).
 *
 * Reply:
 *   - `{ ok: true, data: { users: [{ id, username, displayName, avatarUrl }] } }`
 *   - Each entry's `username/displayName/avatarUrl` is `null` if the bot
 *     doesn't have that user cached.
 */
import { registerVerb, type VerbHandler } from '../registry'
import { env } from '../../../config/env'

const MAX_IDS = 100
const SNOWFLAKE_RE = /^\d{17,20}$/

type ResolvedUser = {
  id: string
  username: string | null
  displayName: string | null
  avatarUrl: string | null
}

type ResolveParams = {
  userIds: string[]
}

function isResolveParams(v: unknown): v is ResolveParams {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  if (!Array.isArray(p.userIds)) return false
  if (p.userIds.length === 0) return true
  return p.userIds.every(id => typeof id === 'string' && SNOWFLAKE_RE.test(id))
}

export const resolveHandler: VerbHandler = async (params, ctx) => {
  if (!isResolveParams(params)) {
    return { ok: false, error: 'bad-params', details: 'expected { userIds: snowflake[] }' }
  }
  if (params.userIds.length > MAX_IDS) {
    return { ok: false, error: 'too-many-ids', details: `max ${MAX_IDS} ids per call, got ${params.userIds.length}` }
  }

  // The bot serves a single guild; per-guild displayName comes from the
  // members cache, which is the only place nicknames live. The user cache
  // covers folks the bot has seen but who aren't (or are no longer) members.
  const guild = ctx.client.guilds.cache.get(env.GUILD_ID)

  // Dedup while preserving caller-supplied order so the panel can zip the
  // response back onto its row list without an extra Map lookup.
  const seen = new Set<string>()
  const out: ResolvedUser[] = []
  for (const id of params.userIds) {
    if (seen.has(id)) continue
    seen.add(id)

    const user = ctx.client.users.cache.get(id)
    const member = guild?.members.cache.get(id)
    if (!user && !member) {
      out.push({ id, username: null, displayName: null, avatarUrl: null })
      continue
    }

    // Prefer the member's per-guild displayName (nickname) when available;
    // otherwise fall back to the global username so the panel still has a
    // human-readable label.
    const baseUser = user ?? member!.user
    out.push({
      id,
      username: baseUser.username,
      displayName: member?.displayName ?? baseUser.username,
      avatarUrl: (member ?? baseUser).displayAvatarURL({ size: 64 }),
    })
  }

  return { ok: true, data: { users: out } }
}

registerVerb('users.resolve', resolveHandler)
