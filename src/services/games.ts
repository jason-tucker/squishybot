/**
 * Games — catalog (sudo-managed list of games) plus per-user prefs
 * (anyone for self, sudo for others). Toggling `wantsView` or `wantsPing`
 * also adds/removes the corresponding Discord role on the target member.
 *
 * The catalog is small and read often (every /games panel render, every
 * /play resolve), so it lives in an in-memory cache loaded by loadSettings()
 * and refreshed on every catalog mutation.
 */
import type { GuildMember } from 'discord.js'
import { and, eq, sql } from 'drizzle-orm'
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
  wantsView: boolean
  wantsPing: boolean
}

export async function listPrefs(guildId: string, userId: string): Promise<GamePref[]> {
  return db.select().from(userGamePrefs)
    .where(and(eq(userGamePrefs.guildId, guildId), eq(userGamePrefs.userId, userId)))
}

/** All visible+non-archived games, paired with the target's pref (default false/false). */
export async function resolvePrefs(guildId: string, userId: string): Promise<ResolvedPref[]> {
  const visible = listGames()
  const prefRows = await listPrefs(guildId, userId)
  const byGame = new Map(prefRows.map(p => [p.gameId, p]))
  return visible.map(g => {
    const p = byGame.get(g.id)
    return { game: g, wantsView: p?.wantsView ?? false, wantsPing: p?.wantsPing ?? false }
  })
}

/**
 * Toggle a single pref + sync the corresponding Discord role on the target.
 * Returns the new state. Caller is responsible for permission checks.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE to flip the boolean atomically and
 * read back the resulting row in a single query.
 */
export async function togglePref(
  member: GuildMember,
  gameId: string,
  which: 'view' | 'ping',
  editor: { editorDiscordId: string; mode: 'self' | 'sudo' }
): Promise<{ wantsView: boolean; wantsPing: boolean } | null> {
  const game = getGame(gameId)
  if (!game) return null

  const col = which === 'view' ? userGamePrefs.wantsView : userGamePrefs.wantsPing
  const [row] = await db.insert(userGamePrefs).values({
    guildId: member.guild.id,
    userId: member.id,
    gameId,
    wantsView: which === 'view',
    wantsPing: which === 'ping',
  }).onConflictDoUpdate({
    target: [userGamePrefs.guildId, userGamePrefs.userId, userGamePrefs.gameId],
    set: { [which === 'view' ? 'wantsView' : 'wantsPing']: sql`NOT ${col}` },
  }).returning()

  const next = { wantsView: row.wantsView, wantsPing: row.wantsPing }
  const enabled = which === 'view' ? next.wantsView : next.wantsPing

  const roleId = which === 'view' ? game.roleId : game.pingRoleId
  if (roleId) {
    try {
      const reason = `game-pref toggle by=${editor.editorDiscordId} mode=${editor.mode}`
      if (enabled) await member.roles.add(roleId, reason)
      else await member.roles.remove(roleId, reason)
    } catch (err) {
      logger.warn(`Failed to sync role ${roleId} for ${member.id} on game ${game.name}:`, err)
    }
  }

  logger.info(`game-pref-toggle by=${editor.editorDiscordId} target=${member.id} mode=${editor.mode} game=${game.name} which=${which} now=${enabled}`)

  return next
}

// ---------------------------------------------------------------------------
// /play rate limit — in-memory map keyed by (guildId:userId:gameId)
// ---------------------------------------------------------------------------

const PLAY_COOLDOWN_MS = 30 * 60_000  // 30 min
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
