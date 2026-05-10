/**
 * Games — catalog (sudo-managed list of games) plus per-user prefs
 * (anyone for self, sudo for others). Toggling `wantsView` or `wantsPing`
 * also adds/removes the corresponding Discord role on the target member.
 *
 * The catalog is small and read often (every /games panel render, every
 * /play resolve), so it lives in an in-memory cache loaded by loadSettings()
 * and refreshed on every catalog mutation.
 */
import type { Guild, GuildBasedChannel, GuildMember } from 'discord.js'
import { PermissionFlagsBits } from 'discord.js'
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
  /** Effective view state: DB row OR a member-level VIEW_CHANNEL allow on the game's channel. */
  wantsView: boolean
  /** Effective ping state: DB row OR the member already holds the ping role. */
  wantsPing: boolean
  /** Whether the effective state was inferred from current Discord state (channel overwrite for view, ping role for ping) rather than an explicit DB pref. */
  fromRole: { view: boolean; ping: boolean }
}

export async function listPrefs(guildId: string, userId: string): Promise<GamePref[]> {
  return db.select().from(userGamePrefs)
    .where(and(eq(userGamePrefs.guildId, guildId), eq(userGamePrefs.userId, userId)))
}

/**
 * Find the Discord role that matches a game's PING role.
 *
 *   1. Prefer the explicit `pingRoleId` on the catalog row.
 *   2. Fall back to a case-insensitive name/alias match against the guild
 *      roles cache. Most servers already have a role named after the game
 *      (e.g. `Overwatch`, `Minecraft`); we treat those as the ping role
 *      so /games and /play work without sudo wiring every entry first.
 *
 * `view` is now backed by a per-channel permission overwrite (see
 * `matchedViewChannel` and the setPref view branch); the legacy `roleId`
 * field is preserved on the schema but no longer surfaced.
 */
export function matchedPingRoleId(guild: Guild, game: Game): string | null {
  if (game.pingRoleId && guild.roles.cache.has(game.pingRoleId)) return game.pingRoleId
  const candidates = [game.name, ...game.aliases].map(s => s.trim().toLowerCase()).filter(Boolean)
  for (const role of guild.roles.cache.values()) {
    if (candidates.includes(role.name.trim().toLowerCase())) return role.id
  }
  return null
}

/** Resolve the channel that "View" toggles access to. Explicit only — no name fallback (channel naming varies too much). */
export function matchedViewChannel(guild: Guild, game: Game): GuildBasedChannel | null {
  if (!game.channelId) return null
  return guild.channels.cache.get(game.channelId) ?? null
}

/**
 * All visible+non-archived games, paired with the target's effective prefs.
 *
 * Effective state per game:
 *   wantsView = DB row || member has channel-level VIEW_CHANNEL allow on game.channelId
 *   wantsPing = DB row || member holds the matched ping role
 *
 * `fromRole` flags state inferred from current Discord state rather than an
 * explicit DB row (so the UI can mark it as "via existing access"). The name
 * is historical — for view it's now "via existing channel access" — but the
 * meaning to consumers is the same: not yet persisted.
 */
export async function resolvePrefs(guildOrId: Guild | string, userOrMember: string | GuildMember): Promise<ResolvedPref[]> {
  const guildId = typeof guildOrId === 'string' ? guildOrId : guildOrId.id
  const userId = typeof userOrMember === 'string' ? userOrMember : userOrMember.id
  const member = typeof userOrMember === 'string' ? null : userOrMember
  const guild: Guild | null = typeof guildOrId === 'string' ? null : guildOrId

  const visible = listGames()
  const prefRows = await listPrefs(guildId, userId)
  const byGame = new Map(prefRows.map(p => [p.gameId, p]))

  return visible.map(g => {
    const p = byGame.get(g.id)
    const hasRow = !!p

    // View — explicit member-level VIEW_CHANNEL allow on game.channelId.
    let channelView = false
    if (member && guild) {
      const ch = matchedViewChannel(guild, g)
      const ow = ch && 'permissionOverwrites' in ch ? (ch as any).permissionOverwrites.cache.get(member.id) : null
      if (ow?.allow?.has(PermissionFlagsBits.ViewChannel)) channelView = true
    }

    // Ping — name-fallback resolves the role.
    const pingRoleId = guild ? matchedPingRoleId(guild, g) : g.pingRoleId
    const rolePing = !!(member && pingRoleId && member.roles.cache.has(pingRoleId))

    // The DB row is authoritative once it exists. Discord's overwrite/role
    // caches lag the API write by a gateway round-trip, so OR-ing them in
    // would make a freshly-revoked toggle still read as "on" until the
    // CHANNEL_UPDATE event arrives — which is exactly the "click Leave
    // Channel and nothing happens" bug. Only fall back to inferring from
    // current Discord state when there's no DB row at all.
    const wantsView = hasRow ? p!.wantsView : channelView
    const wantsPing = hasRow ? p!.wantsPing : rolePing
    return {
      game: g,
      wantsView,
      wantsPing,
      fromRole: { view: !hasRow && channelView, ping: !hasRow && rolePing },
    }
  })
}

/**
 * Set a pref to an explicit value, persisting it in the DB and applying the
 * Discord-side change (channel overwrite for view, role for ping).
 *
 *   view  → channel-level ViewChannel/ReadMessageHistory allow on game.channelId
 *           (delete the member overwrite when value=false).
 *   ping  → add/remove the matched ping role.
 *
 * The DB row is always written so that prefs persist across the user leaving
 * and rejoining the server (see `restoreMemberPrefs` for the rejoin path).
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

  const reason = `game-pref set by=${editor.editorDiscordId} mode=${editor.mode}`
  if (which === 'view') {
    await applyViewAccess(member, game, value, reason)
  } else {
    await applyPingRole(member, game, value, reason)
  }

  logger.info(`game-pref-set by=${editor.editorDiscordId} target=${member.id} mode=${editor.mode} game=${game.name} which=${which} now=${value}`)
  return { wantsView: row.wantsView, wantsPing: row.wantsPing }
}

async function applyViewAccess(member: GuildMember, game: Game, value: boolean, reason: string): Promise<void> {
  const ch = matchedViewChannel(member.guild, game)
  if (!ch || !('permissionOverwrites' in ch)) return
  try {
    if (value) {
      await (ch as any).permissionOverwrites.edit(member.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
      }, { reason })
    } else {
      await (ch as any).permissionOverwrites.delete(member.id, reason)
    }
  } catch (err) {
    logger.warn(`Failed to sync view channel ${ch.id} for ${member.id} on game ${game.name}:`, err)
  }
}

async function applyPingRole(member: GuildMember, game: Game, value: boolean, reason: string): Promise<void> {
  const roleId = matchedPingRoleId(member.guild, game)
  if (!roleId) return
  try {
    if (value) await member.roles.add(roleId, reason)
    else await member.roles.remove(roleId, reason)
  } catch (err) {
    logger.warn(`Failed to sync ping role ${roleId} for ${member.id} on game ${game.name}:`, err)
  }
}

/**
 * Re-apply every persisted pref for a member to Discord. Called from the
 * guildMemberAdd handler so a returning user gets their channel access and
 * ping roles back even though Discord drops their roles/overwrites on leave.
 *
 * Best-effort: failures are warned, never thrown — we don't want one missing
 * channel to block the rest of someone's prefs from restoring.
 */
export async function restoreMemberPrefs(member: GuildMember): Promise<{ restored: number; skipped: number }> {
  const prefs = await listPrefs(member.guild.id, member.id)
  let restored = 0
  let skipped = 0
  for (const p of prefs) {
    const game = getGame(p.gameId)
    if (!game) { skipped++; continue }
    const reason = `game-pref restore on rejoin (member ${member.id})`
    if (p.wantsView) await applyViewAccess(member, game, true, reason)
    if (p.wantsPing) await applyPingRole(member, game, true, reason)
    if (p.wantsView || p.wantsPing) restored++
  }
  if (restored > 0) {
    logger.info(`Restored game prefs for ${member.user.tag} (${member.id}): ${restored} game(s)`)
  }
  return { restored, skipped }
}

// ---------------------------------------------------------------------------
// Interest counts — how many other members are signed up per game
// ---------------------------------------------------------------------------

export interface GameInterest {
  /** Distinct members (by Discord id) with VIEW_CHANNEL allow on the game's channel OR wantsView=true in DB. */
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

  // 2. View interest: members with explicit channel-level VIEW_CHANNEL allow
  //    on game.channelId. Walks the channel's permission overwrites cache
  //    (member-typed overwrites with the bit set) and unions with DB rows.
  //    Ping interest: members holding the matched ping role.
  const out = new Map<string, GameInterest>()
  for (const g of all) {
    const viewIds = new Set(dbViewByGame.get(g.id) ?? [])
    const pingIds = new Set(dbPingByGame.get(g.id) ?? [])

    const ch = matchedViewChannel(guild, g)
    if (ch && 'permissionOverwrites' in ch) {
      for (const ow of (ch as any).permissionOverwrites.cache.values()) {
        // OverwriteType.Member === 1 in discord.js
        if (ow.type === 1 && ow.allow?.has(PermissionFlagsBits.ViewChannel)) viewIds.add(ow.id)
      }
    }

    const pingRoleId = matchedPingRoleId(guild, g)
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

/** Lazy sweep: drop entries past their cooldown window. Without this the Map
 *  grows monotonically with unique (user × game) tuples over the bot's life. */
function sweepPlayCooldowns(): void {
  const cutoff = Date.now() - PLAY_COOLDOWN_MS
  for (const [k, t] of lastPlayAt) if (t < cutoff) lastPlayAt.delete(k)
}

export function checkPlayCooldown(guildId: string, userId: string, gameId: string): { ok: true } | { ok: false; remainingSec: number } {
  const key = `${guildId}:${userId}:${gameId}`
  const last = lastPlayAt.get(key) ?? 0
  const remaining = PLAY_COOLDOWN_MS - (Date.now() - last)
  if (remaining > 0) return { ok: false, remainingSec: Math.ceil(remaining / 1000) }
  return { ok: true }
}

export function markPlayUsed(guildId: string, userId: string, gameId: string): void {
  // Sweep on write — cheap and bounds the Map. Read path stays O(1).
  if (lastPlayAt.size > 100) sweepPlayCooldowns()
  lastPlayAt.set(`${guildId}:${userId}:${gameId}`, Date.now())
}

export function clearPlayCooldown(guildId: string, userId: string, gameId: string): void {
  lastPlayAt.delete(`${guildId}:${userId}:${gameId}`)
}
