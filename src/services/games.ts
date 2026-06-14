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
import { ChannelType, PermissionFlagsBits } from 'discord.js'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { games, userGamePrefs } from '../db/schema'
import { logger } from './logger'
import { getBoolSetting, getSetting } from './settings'

/**
 * Master switch for the "View defaults ON" model (opt-out instead of opt-in).
 *
 * OFF (default): game channels are hidden from @everyone; a member gets View by
 *   receiving a per-member ViewChannel *allow* overwrite. No pref row = no view.
 * ON: game channels are visible to @everyone; a member opts OUT by receiving a
 *   per-member ViewChannel *deny* overwrite. No pref row = view ON (for games
 *   that have a channel). Pings are unaffected by this flag — they stay opt-in.
 *
 * Stored in bot_settings as `games.default_view_on`. Toggling it runs a backfill
 * (see applyDefaultViewBackfill) that flips every game channel's @everyone view.
 */
export const GAMES_DEFAULT_VIEW_ON_KEY = 'games.default_view_on'
export function gameDefaultViewOn(): boolean {
  return getBoolSetting(GAMES_DEFAULT_VIEW_ON_KEY, false)
}

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
// Discord provisioning — auto-create role + channel for a freshly-added game.
// Called from /sudo → Settings → Games → Add Game.
//
// Strategy mirrors provisionStaffRoles: prefer existing-by-name (so adding a
// catalog row for a game that already has a Discord role/channel just links
// the existing ones), only create when nothing matches. New channels are
// hidden from @everyone so per-member view overwrites are the gate.
// ---------------------------------------------------------------------------

export type GameProvisionAction = 'created' | 'linked' | 'kept' | 'failed'
export interface GameProvisionResult {
  role: { action: GameProvisionAction; id: string | null; error?: string }
  channel: { action: GameProvisionAction; id: string | null; error?: string }
}

/** Discord channel-name slug from a game name. Lowercase, alphanumerics + hyphens, max 100 chars. */
export function gameChannelSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100)
  return slug || 'game'
}

export async function provisionGameDiscord(
  guild: Guild,
  game: Game,
  byUserId: string,
): Promise<{ game: Game; result: GameProvisionResult }> {
  const result: GameProvisionResult = {
    role: { action: 'kept', id: game.pingRoleId },
    channel: { action: 'kept', id: game.channelId },
  }
  const patch: Partial<Game> = {}

  // --- Role: link by name match, else create. Skip if already linked + valid.
  const linkedRole = game.pingRoleId ? guild.roles.cache.get(game.pingRoleId) ?? null : null
  if (!linkedRole) {
    const candidates = [game.name, ...game.aliases]
      .map(s => s.trim().toLowerCase()).filter(Boolean)
    const byName = guild.roles.cache.find(r =>
      !r.managed && candidates.includes(r.name.trim().toLowerCase())
    ) ?? null
    if (byName) {
      patch.pingRoleId = byName.id
      result.role = { action: 'linked', id: byName.id }
    } else {
      try {
        const created = await guild.roles.create({
          name: game.name,
          mentionable: true,
          hoist: false,
          permissions: [],
          reason: `auto-create game role for "${game.name}" by ${byUserId}`,
        })
        patch.pingRoleId = created.id
        result.role = { action: 'created', id: created.id }
      } catch (err) {
        logger.warn(`Failed to create role for game ${game.name}:`, err)
        result.role = { action: 'failed', id: null, error: (err as Error).message }
      }
    }
  }

  // --- Channel: link by exact-slug match, but ONLY within the configured
  //     games category. Without the parent scope, adding a game named e.g.
  //     "general" or "lobby" silently re-targets the server's existing
  //     #general / #lobby — and then the per-member view overwrites we
  //     write on /games toggles would be applied to the wrong channel.
  //     Scoping the match means we only ever link to channels that are
  //     already living under the games-category umbrella the sudo set up.
  const categorySetting = getSetting('channel.games_category')
  const parent = categorySetting && guild.channels.cache.has(categorySetting)
    ? categorySetting : null

  const linkedChannel = game.channelId ? guild.channels.cache.get(game.channelId) ?? null : null
  if (!linkedChannel) {
    const slug = gameChannelSlug(game.name)
    // If a games-category is set, only link channels already inside it. If
    // not, only link top-level channels (parentId === null) — never a
    // channel sitting under some unrelated category.
    const byName = guild.channels.cache.find(c =>
      c.type === ChannelType.GuildText
      && c.name === slug
      && c.parentId === parent
    ) ?? null
    if (byName) {
      patch.channelId = byName.id
      patch.categoryId = byName.parentId ?? null
      result.channel = { action: 'linked', id: byName.id }
    } else {
      try {
        const created = await guild.channels.create({
          name: slug,
          type: ChannelType.GuildText,
          parent: parent ?? undefined,
          // Default-on: visible to @everyone (opt-out model). Default-off:
          // hidden, gated by per-member view overwrites (opt-in model).
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              [gameDefaultViewOn() ? 'allow' : 'deny']: [PermissionFlagsBits.ViewChannel],
            },
          ],
          reason: `auto-create game channel for "${game.name}" by ${byUserId}`,
        })
        patch.channelId = created.id
        patch.categoryId = parent
        result.channel = { action: 'created', id: created.id }
      } catch (err) {
        logger.warn(`Failed to create channel for game ${game.name}:`, err)
        result.channel = { action: 'failed', id: null, error: (err as Error).message }
      }
    }
  }

  let updated = game
  if (Object.keys(patch).length > 0) {
    const row = await updateGame(game.id, patch)
    if (row) updated = row
  }
  return { game: updated, result }
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

    // View — member-level overwrite on game.channelId. We read both the allow
    // (default-off model: explicit opt-in) and the deny (default-on model:
    // explicit opt-out) bits.
    const defOn = gameDefaultViewOn()
    let channelView = false
    let channelDeny = false
    let hasChannel = false
    if (member && guild) {
      const ch = matchedViewChannel(guild, g)
      hasChannel = !!ch
      const ow = ch && 'permissionOverwrites' in ch ? (ch as any).permissionOverwrites.cache.get(member.id) : null
      if (ow?.allow?.has(PermissionFlagsBits.ViewChannel)) channelView = true
      if (ow?.deny?.has(PermissionFlagsBits.ViewChannel)) channelDeny = true
    } else {
      hasChannel = !!g.channelId
    }
    // Effective "view" with no DB row:
    //   default-on : visible to all → ON when the game has a channel and the
    //                member carries no personal deny overwrite.
    //   default-off: only when the member already has an explicit allow.
    const inferredView = defOn ? (hasChannel && !channelDeny) : channelView

    // Ping — name-fallback resolves the role.
    const pingRoleId = guild ? matchedPingRoleId(guild, g) : g.pingRoleId
    const rolePing = !!(member && pingRoleId && member.roles.cache.has(pingRoleId))

    // The DB row is authoritative once it exists. Discord's overwrite/role
    // caches lag the API write by a gateway round-trip, so OR-ing them in
    // would make a freshly-revoked toggle still read as "on" until the
    // CHANNEL_UPDATE event arrives — which is exactly the "click Leave
    // Channel and nothing happens" bug. Only fall back to inferring from
    // current Discord state when there's no DB row at all.
    const wantsView = hasRow ? p!.wantsView : inferredView
    const wantsPing = hasRow ? p!.wantsPing : rolePing
    return {
      game: g,
      wantsView,
      wantsPing,
      // `fromRole.view` marks "inferred from an existing allow you already have,
      // toggle to persist" — only meaningful in the default-off opt-in model.
      // Under default-on a no-row view is just the default, not an inferred grant.
      fromRole: { view: !hasRow && !defOn && channelView, ping: !hasRow && rolePing },
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
export type SetPrefResult =
  | { ok: true; wantsView: boolean; wantsPing: boolean }
  | { ok: false; reason: 'game-not-found' | 'view-required-for-ping' }

export async function setPref(
  member: GuildMember,
  gameId: string,
  which: 'view' | 'ping',
  value: boolean,
  editor: { editorDiscordId: string; mode: 'self' | 'sudo' }
): Promise<SetPrefResult> {
  const game = getGame(gameId)
  if (!game) return { ok: false, reason: 'game-not-found' }

  // #23 — Ping role requires View. A user can't opt into pings for a game
  // they can't see. In the default-off (opt-in) model "can see" means an
  // explicit wantsView=true row. Under default-on everyone can see every game
  // channel by default, so the precondition is always satisfied and we skip
  // the gate. Sudo doesn't bypass this — the rule is about the target's prefs.
  if (which === 'ping' && value === true && !gameDefaultViewOn()) {
    const [existing] = await db.select().from(userGamePrefs).where(
      and(
        eq(userGamePrefs.guildId, member.guild.id),
        eq(userGamePrefs.userId, member.id),
        eq(userGamePrefs.gameId, gameId),
      ),
    )
    if (!existing?.wantsView) return { ok: false, reason: 'view-required-for-ping' }
  }

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
  let finalRow = row
  if (which === 'view') {
    await applyViewAccess(member, game, value, reason)
    // Cascade: turning View off must turn Ping off too — otherwise the user
    // ends up holding the ping role for a channel they can no longer see.
    if (value === false && row.wantsPing) {
      const [pinged] = await db.update(userGamePrefs)
        .set({ wantsPing: false })
        .where(and(
          eq(userGamePrefs.guildId, member.guild.id),
          eq(userGamePrefs.userId, member.id),
          eq(userGamePrefs.gameId, gameId),
        ))
        .returning()
      finalRow = pinged ?? row
      await applyPingRole(member, game, false, `${reason} (cascade from view=false)`)
    }
  } else {
    await applyPingRole(member, game, value, reason)
  }

  logger.info(`game-pref-set by=${editor.editorDiscordId} target=${member.id} mode=${editor.mode} game=${game.name} which=${which} now=${value}`)
  return { ok: true, wantsView: finalRow.wantsView, wantsPing: finalRow.wantsPing }
}

async function applyViewAccess(member: GuildMember, game: Game, value: boolean, reason: string): Promise<void> {
  const ch = matchedViewChannel(member.guild, game)
  if (!ch || !('permissionOverwrites' in ch)) return
  const overwrites = (ch as any).permissionOverwrites
  try {
    if (gameDefaultViewOn()) {
      // Default-on: the channel is visible to @everyone. "View on" means no
      // personal overwrite; "View off" (opt-out) means a personal ViewChannel
      // deny that overrides the @everyone allow.
      if (value) {
        if (overwrites.cache.has(member.id)) await overwrites.delete(member.id, reason)
      } else {
        await overwrites.edit(member.id, { ViewChannel: false }, { reason })
      }
    } else {
      // Default-off: the channel is hidden from @everyone; access is a personal
      // ViewChannel allow.
      if (value) {
        await overwrites.edit(member.id, { ViewChannel: true, ReadMessageHistory: true }, { reason })
      } else if (overwrites.cache.has(member.id)) {
        await overwrites.delete(member.id, reason)
      }
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
  const defOn = gameDefaultViewOn()
  let restored = 0
  let skipped = 0
  for (const p of prefs) {
    const game = getGame(p.gameId)
    if (!game) { skipped++; continue }
    const reason = `game-pref restore on rejoin (member ${member.id})`
    let touched = false
    // View: under default-on, channels are visible by default, so the only
    // thing to re-apply is an opt-OUT (deny). Under default-off, re-apply the
    // opt-IN allow. applyViewAccess reads the same flag and does the right op.
    if (defOn) {
      if (!p.wantsView) { await applyViewAccess(member, game, false, reason); touched = true }
    } else if (p.wantsView) {
      await applyViewAccess(member, game, true, reason); touched = true
    }
    if (p.wantsPing) { await applyPingRole(member, game, true, reason); touched = true }
    if (touched) restored++
  }
  if (restored > 0) {
    logger.info(`Restored game prefs for ${member.user.tag} (${member.id}): ${restored} game(s)`)
  }
  return { restored, skipped }
}

// ---------------------------------------------------------------------------
// Bulk / backfill operations (sudo) — server-wide view & ping management.
// These touch many members/channels, so callers should defer the interaction
// and surface the returned counts.
// ---------------------------------------------------------------------------

/**
 * Flip one game channel's @everyone ViewChannel bit.
 *   visible=true  → allow  (visible to everyone — the default-on baseline)
 *   visible=false → deny   (hidden from everyone — the default-off baseline)
 * Per-member deny overwrites (opt-outs) still win over an @everyone allow, so
 * making a channel visible does NOT un-hide it for members who opted out.
 */
export async function setGameChannelEveryoneVisible(
  guild: Guild,
  game: Game,
  visible: boolean,
  reason: string,
): Promise<boolean> {
  const ch = matchedViewChannel(guild, game)
  if (!ch || !('permissionOverwrites' in ch)) return false
  try {
    await (ch as any).permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: visible }, { reason })
    return true
  } catch (err) {
    logger.warn(`Failed to set @everyone view=${visible} on channel ${ch.id} for game ${game.name}:`, err)
    return false
  }
}

export interface BackfillResult { total: number; changed: number; noChannel: number; failed: number }

/**
 * Apply the default-on/off baseline to every catalog game channel — the
 * "backfill + new joins" mechanism for View. One @everyone flip per channel
 * reaches all current AND future members at once. Existing per-member opt-out
 * denies are preserved (they out-rank the @everyone allow).
 */
export async function applyDefaultViewBackfill(
  guild: Guild,
  visible: boolean,
  byUserId: string,
): Promise<BackfillResult> {
  const all = listGames({ includeArchived: true, includeHidden: true })
  const res: BackfillResult = { total: all.length, changed: 0, noChannel: 0, failed: 0 }
  for (const g of all) {
    if (!g.channelId || !matchedViewChannel(guild, g)) { res.noChannel++; continue }
    const ok = await setGameChannelEveryoneVisible(guild, g, visible, `games default-view backfill visible=${visible} by ${byUserId}`)
    if (ok) res.changed++; else res.failed++
  }
  logger.info(`games default-view backfill visible=${visible} by=${byUserId} changed=${res.changed} noChannel=${res.noChannel} failed=${res.failed}`)
  return res
}

export interface BulkViewResult { ok: boolean; clearedDenies: number; updatedRows: number }

/**
 * Server-wide "everyone can see this game": make the channel visible to
 * @everyone, remove every per-member opt-out deny, and flip stored wantsView
 * rows to true so opt-outs don't reapply on rejoin (ping prefs preserved).
 */
export async function bulkGrantViewEveryone(guild: Guild, gameId: string, byUserId: string): Promise<BulkViewResult> {
  const game = getGame(gameId)
  if (!game) return { ok: false, clearedDenies: 0, updatedRows: 0 }
  const reason = `games bulk grant-view-everyone by ${byUserId}`
  await setGameChannelEveryoneVisible(guild, game, true, reason)
  let clearedDenies = 0
  const ch = matchedViewChannel(guild, game)
  if (ch && 'permissionOverwrites' in ch) {
    for (const ow of [...(ch as any).permissionOverwrites.cache.values()]) {
      if (ow.type === 1 && ow.deny?.has(PermissionFlagsBits.ViewChannel)) {
        await (ch as any).permissionOverwrites.delete(ow.id, reason).then(() => { clearedDenies++ }).catch(() => {})
      }
    }
  }
  const updated = await db.update(userGamePrefs).set({ wantsView: true })
    .where(and(eq(userGamePrefs.guildId, guild.id), eq(userGamePrefs.gameId, gameId), eq(userGamePrefs.wantsView, false)))
    .returning()
  return { ok: true, clearedDenies, updatedRows: updated.length }
}

/**
 * Server-wide "hide this game from everyone": deny @everyone, strip per-member
 * view allows so opted-in members lose access too, and flip stored wantsView
 * rows to false.
 */
export async function bulkRevokeViewEveryone(guild: Guild, gameId: string, byUserId: string): Promise<BulkViewResult> {
  const game = getGame(gameId)
  if (!game) return { ok: false, clearedDenies: 0, updatedRows: 0 }
  const reason = `games bulk hide-from-everyone by ${byUserId}`
  await setGameChannelEveryoneVisible(guild, game, false, reason)
  let clearedAllows = 0
  const ch = matchedViewChannel(guild, game)
  if (ch && 'permissionOverwrites' in ch) {
    for (const ow of [...(ch as any).permissionOverwrites.cache.values()]) {
      if (ow.type === 1 && ow.allow?.has(PermissionFlagsBits.ViewChannel)) {
        await (ch as any).permissionOverwrites.delete(ow.id, reason).then(() => { clearedAllows++ }).catch(() => {})
      }
    }
  }
  const updated = await db.update(userGamePrefs).set({ wantsView: false })
    .where(and(eq(userGamePrefs.guildId, guild.id), eq(userGamePrefs.gameId, gameId), eq(userGamePrefs.wantsView, true)))
    .returning()
  return { ok: true, clearedDenies: clearedAllows, updatedRows: updated.length }
}

/**
 * Server-wide "stop pinging everyone for this game": remove the ping role from
 * every current holder and flip stored wantsPing rows to false.
 */
export async function bulkClearPingsEveryone(guild: Guild, gameId: string, byUserId: string): Promise<{ ok: boolean; removed: number; updatedRows: number }> {
  const game = getGame(gameId)
  if (!game) return { ok: false, removed: 0, updatedRows: 0 }
  const reason = `games bulk clear-pings-everyone by ${byUserId}`
  let removed = 0
  const roleId = matchedPingRoleId(guild, game)
  if (roleId) {
    const role = guild.roles.cache.get(roleId)
    if (role) {
      for (const m of [...role.members.values()]) {
        await m.roles.remove(roleId, reason).then(() => { removed++ }).catch(() => {})
      }
    }
  }
  const updated = await db.update(userGamePrefs).set({ wantsPing: false })
    .where(and(eq(userGamePrefs.guildId, guild.id), eq(userGamePrefs.gameId, gameId), eq(userGamePrefs.wantsPing, true)))
    .returning()
  return { ok: true, removed, updatedRows: updated.length }
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

  const defOn = gameDefaultViewOn()
  const dbViewByGame = new Map<string, Set<string>>()
  const dbViewOffByGame = new Map<string, Set<string>>()
  const dbPingByGame = new Map<string, Set<string>>()
  for (const r of rows) {
    if (r.wantsView) {
      const set = dbViewByGame.get(r.gameId) ?? new Set()
      set.add(r.userId); dbViewByGame.set(r.gameId, set)
    } else {
      // Explicit opt-out — only meaningful under default-on.
      const set = dbViewOffByGame.get(r.gameId) ?? new Set()
      set.add(r.userId); dbViewOffByGame.set(r.gameId, set)
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

    const unionSize = new Set<string>([...viewIds, ...pingIds]).size
    // Under default-on every member with the game's channel sees it unless they
    // opted out, so "view interest" is ~(members − opt-outs). memberCount counts
    // bots too; this is a UI hint, not an exact tally.
    const viewCount = defOn && g.channelId
      ? Math.max(0, guild.memberCount - (dbViewOffByGame.get(g.id)?.size ?? 0))
      : viewIds.size
    const any = defOn && g.channelId ? Math.max(viewCount, unionSize) : unionSize
    out.set(g.id, { view: viewCount, ping: pingIds.size, any })
  }
  return out
}

// ---------------------------------------------------------------------------
// /play rate limit — in-memory map keyed by (guildId:userId:gameId)
// ---------------------------------------------------------------------------

// Default /play cooldown (1800s = 30 min) per CLAUDE.md spec. Per-game
// overrides live in games.play_cooldown_seconds (#22) — null falls back here,
// 0 disables cooldown entirely.
const DEFAULT_PLAY_COOLDOWN_SEC = 1800
const lastPlayAt = new Map<string, number>()

function cooldownSecondsFor(gameId: string): number {
  const g = getGame(gameId)
  if (!g) return DEFAULT_PLAY_COOLDOWN_SEC
  return g.playCooldownSeconds === null || g.playCooldownSeconds === undefined
    ? DEFAULT_PLAY_COOLDOWN_SEC
    : g.playCooldownSeconds
}

/** Lazy sweep: drop entries past the longest possible cooldown window. */
function sweepPlayCooldowns(): void {
  // Use 2h as a generous upper bound; any longer per-game cooldown still bounds
  // the map via the per-tuple checkPlayCooldown read.
  const cutoff = Date.now() - 2 * 60 * 60 * 1000
  for (const [k, t] of lastPlayAt) if (t < cutoff) lastPlayAt.delete(k)
}

export function checkPlayCooldown(guildId: string, userId: string, gameId: string): { ok: true } | { ok: false; remainingSec: number } {
  const cooldownMs = cooldownSecondsFor(gameId) * 1000
  if (cooldownMs <= 0) return { ok: true }
  const key = `${guildId}:${userId}:${gameId}`
  const last = lastPlayAt.get(key) ?? 0
  const remaining = cooldownMs - (Date.now() - last)
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
