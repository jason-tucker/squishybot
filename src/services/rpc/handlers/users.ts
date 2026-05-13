/**
 * `users.resolve` — batch snowflake → @username + avatar lookup for the panel.
 *
 * Today panel pages render raw IDs like `117501528641634310` in audit tables,
 * staff approvals, voice rosters, etc. This verb lets the panel pre-resolve
 * those snowflakes into `{username, displayName, avatarUrl}` in a single
 * round-trip per render.
 *
 * Cache-first with a fetch fallback. Tries `client.users.cache` and
 * `guild.members.cache` first; for any id still missing, falls back to
 * `guild.members.fetch(id)` (Discord API). Squishy is a single-mid-sized
 * guild and the bot has GUILD_MEMBERS intent, but doesn't pre-warm the
 * member cache at boot — so members who haven't done anything recently
 * aren't in the in-process cache yet. Without the fetch fallback, the
 * panel's voice / audit / staff views render raw snowflakes for those
 * members. Concurrency-bounded so 100 stale ids don't fan out into 100
 * parallel REST calls.
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

  // Dedup; collect ids that need a fetch for the second pass.
  const seen = new Set<string>()
  const order: string[] = []
  const resolvedById = new Map<string, ResolvedUser>()
  const missingForFetch: string[] = []

  for (const id of params.userIds) {
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)

    const user = ctx.client.users.cache.get(id)
    const member = guild?.members.cache.get(id)
    if (!user && !member) {
      missingForFetch.push(id)
      continue
    }
    const baseUser = user ?? member!.user
    resolvedById.set(id, {
      id,
      username: baseUser.username,
      displayName: member?.displayName ?? baseUser.username,
      avatarUrl: (member ?? baseUser).displayAvatarURL({ size: 64 }),
    })
  }

  // Fetch fallback for missing ids — concurrency-bounded so a stale chunk
  // of 100 doesn't fan out into 100 parallel Discord API calls. Each fetch
  // primes the in-process member cache so subsequent calls hit `seen-with-this-id`.
  if (guild && missingForFetch.length > 0) {
    const FETCH_CONCURRENCY = 5
    for (let i = 0; i < missingForFetch.length; i += FETCH_CONCURRENCY) {
      const slice = missingForFetch.slice(i, i + FETCH_CONCURRENCY)
      await Promise.all(
        slice.map(async (id) => {
          const member = await guild.members.fetch(id).catch(() => null)
          if (!member) {
            resolvedById.set(id, { id, username: null, displayName: null, avatarUrl: null })
            return
          }
          resolvedById.set(id, {
            id,
            username: member.user.username,
            displayName: member.displayName ?? member.user.username,
            avatarUrl: member.displayAvatarURL({ size: 64 }),
          })
        }),
      )
    }
  } else {
    // No guild — can't fetch. Mark every still-missing id as unresolved.
    for (const id of missingForFetch) {
      resolvedById.set(id, { id, username: null, displayName: null, avatarUrl: null })
    }
  }

  const out: ResolvedUser[] = order.map((id) => resolvedById.get(id)!)
  return { ok: true, data: { users: out } }
}

registerVerb('users.resolve', resolveHandler)
