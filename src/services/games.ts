/**
 * Games — catalog (sudo-managed list of games) plus per-user prefs
 * (anyone for self, sudo for others). Toggling `wantsView` or `wantsPing`
 * also adds/removes the corresponding Discord role on the target member.
 *
 * The catalog is small and read often (every /games panel render, every
 * /play resolve), so it lives in an in-memory cache loaded by loadSettings()
 * and refreshed on every catalog mutation.
 */
import type { Guild, GuildMember } from 'discord.js'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { games, userGamePrefs } from '../db/schema'
import { logger } from './logger'

export type Game = typeof games.$inferSelect
export type GamePref = typeof userGamePrefs.$inferSelect

// ---------------------------------------------------------------------------
// In-memory catalog cache (keyed by game.id, sorted by sortOrder asc)
// ---------------------------------------------------------------------------

const catalog = new Map<string, Game>()

export async function loadGames(): Promise<void> {
  catalog.clear()
  const rows = await db.select().from(games).catch(() => [])
  for (const r of rows) catalog.set(r.id, r)
}

function sortedCatalog(): Game[] {
  return Array.from(catalog.values()).sort((a, b) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
  )
}

// ---------------------------------------------------------------------------
// Catalog reads
// ---------------------------------------------------------------------------

export function listGames(opts?: { includeArchived?: boolean; includeHidden?: boolean }): Game[] {
  return sortedCatalog().filter(g =>
    (opts?.includeArchived ? true : !g.isArchived) &&
    (opts?.includeHidden ? true : g.isVisible)
  )
}

export function getGame(id: string): Game | null {
  return catalog.get(id) ?? null
}

export function findGameByNameOrAlias(query: string): Game | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  for (const g of sortedCatalog()) {
    if (g.name.toLowerCase() === q) return g
    if (g.aliases.some(a => a.toLowerCase() === q)) return g
  }
  return null
}

export function gameCount(): number {
  return catalog.size
}

// ---------------------------------------------------------------------------
// Catalog mutations (sudo-only at the panel layer; this module trusts callers)
// ---------------------------------------------------------------------------

export async function createGame(input: Pick<Game, 'guildId' | 'name'> & Partial<Game>): Promise<Game> {
  const [row] = await db.insert(games).values({
    guildId: input.guildId,
    name: input.name,
    aliases: input.aliases ?? [],
    sortOrder: input.sortOrder ?? 0,
    isVisible: input.isVisible ?? true,
    isArchived: input.isArchived ?? false,
    roleId: input.roleId ?? null,
    pingRoleId: input.pingRoleId ?? null,
    channelId: input.channelId ?? null,
    categoryId: input.categoryId ?? null,
  }).returning()
  catalog.set(row.id, row)
  logger.info(`game-create id=${row.id} name=${row.name}`)
  return row
}

export async function updateGame(id: string, patch: Partial<Game>): Promise<Game | null> {
  const [row] = await db.update(games).set(patch).where(eq(games.id, id)).returning()
  if (!row) return null
  catalog.set(row.id, row)
  logger.info(`game-update id=${id} fields=${Object.keys(patch).join(',')}`)
  return row
}

export async function deleteGame(id: string): Promise<void> {
  await db.delete(games).where(eq(games.id, id))
  catalog.delete(id)
  logger.info(`game-delete id=${id}`)
}

// ---------------------------------------------------------------------------
// User game prefs
// ---------------------------------------------------------------------------

export interface ResolvedPref {
  game: Game
  /** Effective view state: DB row OR the member already holds the view role. */
  wantsView: boolean
  /** Effective ping state: DB row OR the member already holds the ping role. */
  wantsPing: boolean
  /** Whether the effective state was inferred from a Discord role rather than an explicit DB pref. */
  fromRole: { view: boolean; ping: boolean }
}

export async function listPrefs(guildId: string, userId: string): Promise<GamePref[]> {
  return db.select().from(userGamePrefs)
    .where(and(eq(userGamePrefs.guildId, guildId), eq(userGamePrefs.userId, userId)))
}

/**
 * Find the Discord role that matches a game by id (preferred) or by
 * name/alias (case-insensitive fallback). Lets us auto-prefill prefs and
 * interest counts even when sudo hasn't wired the role explicitly.
 *
 * `kind='view'` checks game.roleId first; `kind='ping'` checks game.pingRoleId.
 * Both fall back to name+alias matching against guild.roles.cache when unset.
 */
export function matchedRoleId(guild: Guild, game: Game, kind: 'view' | 'ping'): string | null {
  const explicit = kind === 'view' ? game.roleId : game.pingRoleId
  if (explicit && guild.roles.cache.has(explicit)) return explicit
  // Name/alias fallback — only applies for the view role (the canonical "I play this" role).
  // Ping roles are typically named distinctively (e.g. "Overwatch Pings"), so we don't auto-match.
  if (kind === 'ping') return null
  const candidates = [game.name, ...game.aliases].map(s => s.trim().toLowerCase()).filter(Boolean)
  for (const role of guild.roles.cache.values()) {
    if (candidates.includes(role.name.trim().toLowerCase())) return role.id
  }
  return null
}

/**
 * All visible+non-archived games, paired with the target's effective prefs.
 *
 * Effective = DB row || member holds the configured Discord role.
 * If a member has the role but no DB row, that's recorded in `fromRole`
 * so the UI can show "(role)" and the writer can persist it on next toggle.
 *
 * Pass `member` to use role-based prefill; pass guildId+userId only for the
 * DB-only path (e.g. background jobs).
 */
export async function resolvePrefs(guildOrId: Guild | string, userOrMember: string | GuildMember): Promise<ResolvedPref[]> {
  const guildId = typeof guildOrId === 'string' ? guildOrId : guildOrId.id
  const userId = typeof userOrMember === 'string' ? userOrMember : userOrMember.id
  const member = typeof userOrMember === 'string' ? null : userOrMember
  // Only Guild-form input gives us role-name fallback; the string-only path is DB-only.
  const guild: Guild | null = typeof guildOrId === 'string' ? null : guildOrId

  const visible = listGames()
  const prefRows = await listPrefs(guildId, userId)
  const byGame = new Map(prefRows.map(p => [p.gameId, p]))

  return visible.map(g => {
    const p = byGame.get(g.id)
    const dbView = p?.wantsView ?? false
    const dbPing = p?.wantsPing ?? false
    const viewRoleId = guild ? matchedRoleId(guild, g, 'view') : g.roleId
    const pingRoleId = g.pingRoleId  // ping roles only resolve explicitly; see matchedRoleId
    const roleView = !!(member && viewRoleId && member.roles.cache.has(viewRoleId))
    const rolePing = !!(member && pingRoleId && member.roles.cache.has(pingRoleId))
    return {
      game: g,
      wantsView: dbView || roleView,
      wantsPing: dbPing || rolePing,
      fromRole: { view: !dbView && roleView, ping: !dbPing && rolePing },
    }
  })
}

/**
 * Set a pref to an explicit value (instead of toggle), syncing the role.
 * Use this when the UI knows the desired end state — avoids ambiguity when
 * effective state was inferred from a role but the DB row says false.
 */
export async function setPref(
  member: GuildMember,
  gameId: string,
  which: 'view' | 'ping',
  value: boolean,
  editor: { editorDiscordId: string; mode: 'self' | 'sudo' }
): Promise<{ wantsView: boolean; wantsPing: boolean } | null> {
  const game = getGame(gameId)
  if (!game) return null

  const [row] = await db.insert(userGamePrefs).values({
    guildId: member.guild.id,
    userId: member.id,
    gameId,
    wantsView: which === 'view' ? value : false,
    wantsPing: which === 'ping' ? value : false,
  }).onConflictDoUpdate({
    target: [userGamePrefs.guildId, userGamePrefs.userId, userGamePrefs.gameId],
    set: { [which === 'view' ? 'wantsView' : 'wantsPing']: value },
  }).returning()

  // Resolve the role to sync. Falls back to name-match for view roles when
  // sudo hasn't wired one explicitly — keeps "I have the role" and "I have
  // the pref" in sync even when the catalog is half-configured.
  const roleId = matchedRoleId(member.guild, game, which)
  if (roleId) {
    try {
      const reason = `game-pref set by=${editor.editorDiscordId} mode=${editor.mode}`
      if (value) await member.roles.add(roleId, reason)
      else await member.roles.remove(roleId, reason)
    } catch (err) {
      logger.warn(`Failed to sync role ${roleId} for ${member.id} on game ${game.name}:`, err)
    }
  }

  logger.info(`game-pref-set by=${editor.editorDiscordId} target=${member.id} mode=${editor.mode} game=${game.name} which=${which} now=${value}`)

  return { wantsView: row.wantsView, wantsPing: row.wantsPing }
}

// ---------------------------------------------------------------------------
// Interest counts — how many other members are signed up per game
// ---------------------------------------------------------------------------

export interface GameInterest {
  /** Distinct members (by Discord id) who hold the View role OR have wantsView=true. */
  view: number
  /** Distinct members who hold the Ping role OR have wantsPing=true. */
  ping: number
  /** Union of both, "anyone interested in this game at all". */
  any: number
}

/**
 * Best-effort interest counts. Combines two sources:
 *   1. Members holding the role (from cache — needs GUILD_MEMBERS intent)
 *   2. user_game_prefs rows with the corresponding flag set
 *
 * The role count is authoritative for users who joined via a third-party
 * sticker bot (no DB row); the DB count covers users with the pref toggled
 * before the role was wired up. We take the union so neither source goes
 * uncounted.
 */
export async function gameInterestCounts(guild: Guild): Promise<Map<string, GameInterest>> {
  const all = listGames({ includeArchived: true, includeHidden: true })
  if (all.length === 0) return new Map()

  // 1. Bulk-fetch the prefs rows for this guild once, group by game.
  const rows = await db.select().from(userGamePrefs)
    .where(and(
      eq(userGamePrefs.guildId, guild.id),
      inArray(userGamePrefs.gameId, all.map(g => g.id)),
    ))

  const dbViewByGame = new Map<string, Set<string>>()
  const dbPingByGame = new Map<string, Set<string>>()
  for (const r of rows) {
    if (r.wantsView) {
      const set = dbViewByGame.get(r.gameId) ?? new Set()
      set.add(r.userId); dbViewByGame.set(r.gameId, set)
    }
    if (r.wantsPing) {
      const set = dbPingByGame.get(r.gameId) ?? new Set()
      set.add(r.userId); dbPingByGame.set(r.gameId, set)
    }
  }

  // 2. Walk roles from guild.roles.cache. role.members reflects the in-memory
  //    member cache; we rely on GUILD_MEMBERS intent + Partials.GuildMember.
  const out = new Map<string, GameInterest>()
  for (const g of all) {
    const viewIds = new Set(dbViewByGame.get(g.id) ?? [])
    const pingIds = new Set(dbPingByGame.get(g.id) ?? [])
    const viewRoleId = matchedRoleId(guild, g, 'view')
    const pingRoleId = matchedRoleId(guild, g, 'ping')
    if (viewRoleId) {
      const role = guild.roles.cache.get(viewRoleId)
      if (role) for (const id of role.members.keys()) viewIds.add(id)
    }
    if (pingRoleId) {
      const role = guild.roles.cache.get(pingRoleId)
      if (role) for (const id of role.members.keys()) pingIds.add(id)
    }
    const any = new Set<string>([...viewIds, ...pingIds])
    out.set(g.id, { view: viewIds.size, ping: pingIds.size, any: any.size })
  }
  return out
}

// ---------------------------------------------------------------------------
// /play rate limit — in-memory map keyed by (guildId:userId:gameId)
// ---------------------------------------------------------------------------

const PLAY_COOLDOWN_MS = 10 * 60_000  // 10 min — sudo bypasses entirely (see /play)
const lastPlayAt = new Map<string, number>()

export function checkPlayCooldown(guildId: string, userId: string, gameId: string): { ok: true } | { ok: false; remainingSec: number } {
  const key = `${guildId}:${userId}:${gameId}`
  const last = lastPlayAt.get(key) ?? 0
  const remaining = PLAY_COOLDOWN_MS - (Date.now() - last)
  if (remaining > 0) return { ok: false, remainingSec: Math.ceil(remaining / 1000) }
  return { ok: true }
}

export function markPlayUsed(guildId: string, userId: string, gameId: string): void {
  lastPlayAt.set(`${guildId}:${userId}:${gameId}`, Date.now())
}

export function clearPlayCooldown(guildId: string, userId: string, gameId: string): void {
  lastPlayAt.delete(`${guildId}:${userId}:${gameId}`)
}
