/**
 * Resolves "who counts as a bot owner" dynamically from the Discord
 * Application Team plus the BOT_OWNER_ID env fallback.
 *
 * Per spec: Team Admins + Developers count (Read-only members do not).
 * The team owner (the Discord account that owns the team itself) is always
 * included. Env BOT_OWNER_ID is always included so the bot keeps working
 * before a Team is configured on the dev portal.
 *
 * Cached for 60s to avoid hammering the application.fetch() endpoint on
 * every interaction. The cache is process-local; restart clears it.
 */
import { Team, type Client } from 'discord.js'
import { env } from '../config/env'
import { logger } from './logger'

const CACHE_TTL_MS = 60_000

// Roles on Team Members that grant bot-owner status. Discord's API returns
// these as string enums; we compare case-insensitively to be tolerant of
// future renames (e.g. 'read_only' → 'readonly').
const OWNER_ROLE_NAMES = new Set(['admin', 'developer'])

let cache: { ids: Set<string>; expiresAt: number } | null = null

async function refresh(client: Client): Promise<Set<string>> {
  const ids = new Set<string>()
  if (env.BOT_OWNER_ID) ids.add(env.BOT_OWNER_ID)

  try {
    const app = client.application ?? null
    if (app) {
      await app.fetch().catch(() => null)
      // In discord.js v14, ClientApplication.owner is `User | Team | null`.
      // When the bot belongs to a Team on the dev portal, this is a Team.
      const team = app.owner instanceof Team ? app.owner : null
      if (team) {
        // The team's own owner always counts, regardless of their TeamMember role.
        if (team.ownerId) ids.add(team.ownerId)
        for (const [, member] of team.members) {
          const role = String(member.role ?? '').toLowerCase().replace(/_/g, '')
          if (OWNER_ROLE_NAMES.has(role)) ids.add(member.user.id)
        }
      }
    }
  } catch (err) {
    logger.warn('botOwner: failed to refresh team membership', err)
  }

  cache = { ids, expiresAt: Date.now() + CACHE_TTL_MS }
  return ids
}

export async function getBotOwnerIds(client: Client): Promise<Set<string>> {
  if (cache && cache.expiresAt > Date.now()) return cache.ids
  return refresh(client)
}

export async function isBotOwner(client: Client, userId: string): Promise<boolean> {
  const ids = await getBotOwnerIds(client)
  return ids.has(userId)
}

/** Force the next isBotOwner / getBotOwnerIds call to re-fetch from Discord. */
export function invalidateBotOwnerCache(): void {
  cache = null
}

/**
 * Pre-warm the cache on bot READY so the first interaction doesn't pay the
 * application.fetch() latency. Also logs the resolved owners so any
 * misconfiguration is obvious from the boot log.
 */
export async function logResolvedBotOwners(client: Client): Promise<void> {
  const ids = await refresh(client)
  if (ids.size === 0) {
    logger.warn('Bot owners: none resolved. Set BOT_OWNER_ID env or assign Admins/Developers on the Discord dev portal Team.')
    return
  }
  logger.info(`Bot owners (${ids.size}): ${[...ids].join(', ')}`)
}
