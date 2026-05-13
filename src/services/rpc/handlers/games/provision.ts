/**
 * `game.provision` — atomically create a Discord channel, a view role, a
 * ping role, and a `games` table row that wires them together.
 *
 * High-level convenience verb for the panel's "Auto-provision" checkbox on
 * the Add Game form. The bot already has the lower-level building blocks
 * (`provisionGameDiscord` in `src/services/games.ts`), but that helper only
 * runs after the row already exists, and it doesn't create a separate
 * "view" role — it links/creates one role per game (`pingRoleId`) and one
 * channel. This verb is for the new workflow where the panel wants three
 * fresh Discord resources up front, all owned by the game.
 *
 * Params: `{ name, parentCategoryId?, position?, viewRoleColor?, pingRoleColor?,
 *           playCooldownSeconds?, autoArchiveDays? }`
 *
 *   parentCategoryId resolution order: explicit param → bot_setting
 *     `channel.games_category` → no parent (top-level channel).
 *
 *   position defaults to 3 per the panel spec ("#3 in the games category");
 *   it's the Discord sort-key within the parent, 0-indexed, so 3 places the
 *   new channel 4th from the top.
 *
 * Atomicity: we create channel → view role → ping role → DB row in that
 * order, and on any failure we best-effort delete whatever's been created
 * so far before returning. The DB write is last so a partial Discord-side
 * failure never leaves orphan IDs in the catalog.
 *
 * Idempotency: if a games row with the same trimmed/case-insensitive name
 * already exists in the configured guild, we short-circuit before any
 * Discord call and return `{ ok: false, error: 'game-exists', details: { gameId } }`.
 */
import { z } from 'zod'
import { ChannelType, DiscordAPIError, PermissionFlagsBits, type Guild } from 'discord.js'
import { and, eq, sql } from 'drizzle-orm'
import { registerVerb, type VerbHandler } from '../../registry'
import { env } from '../../../../config/env'
import { db } from '../../../../db/client'
import { games } from '../../../../db/schema'
import { logger } from '../../../logger'
import { getSetting } from '../../../settings'
import { createGame, gameChannelSlug, loadGames } from '../../../games'

const Schema = z.object({
  name: z.string().trim().min(1).max(100),
  parentCategoryId: z.string().min(15).max(25).optional(),
  position: z.number().int().min(0).max(1000).optional(),
  viewRoleColor: z.number().int().min(0).max(0xFFFFFF).optional(),
  pingRoleColor: z.number().int().min(0).max(0xFFFFFF).optional(),
  playCooldownSeconds: z.number().int().min(0).max(86400).optional(),
  autoArchiveDays: z.number().int().min(0).max(3650).optional(),
})

// Default channel position when caller doesn't pin one. Per the panel spec:
// "auto add new games and roles #3 in the games category" — Discord's
// `position` is a 0-indexed sort key inside a parent, so 3 lands the channel
// 4th from the top. Panel can override.
const DEFAULT_CHANNEL_POSITION = 3
// Default channel-name prefix. Snake-cased game slug gets prepended with
// this so e.g. `cyberpunk 2077` → `🎮-cyberpunk-2077`. Override-able via the
// `channel.games_prefix` bot_setting if a server wants a different emoji.
const DEFAULT_CHANNEL_PREFIX = '🎮-'

/**
 * Best-effort cleanup of partially-created resources. Each delete is
 * independent — if the role delete fails we still try the channel.
 * Failures are warn-logged, never thrown, because the caller is already
 * on the error path.
 */
async function rollback(
  guild: Guild,
  created: { channelId?: string; viewRoleId?: string; pingRoleId?: string },
  reason: string,
): Promise<void> {
  if (created.pingRoleId) {
    await guild.roles.delete(created.pingRoleId, `provision rollback: ${reason}`)
      .catch(err => logger.warn(`game.provision rollback: failed to delete ping role ${created.pingRoleId}: ${(err as Error).message}`))
  }
  if (created.viewRoleId) {
    await guild.roles.delete(created.viewRoleId, `provision rollback: ${reason}`)
      .catch(err => logger.warn(`game.provision rollback: failed to delete view role ${created.viewRoleId}: ${(err as Error).message}`))
  }
  if (created.channelId) {
    const ch = guild.channels.cache.get(created.channelId)
    await ch?.delete(`provision rollback: ${reason}`)
      .catch(err => logger.warn(`game.provision rollback: failed to delete channel ${created.channelId}: ${(err as Error).message}`))
  }
}

export const provisionHandler: VerbHandler = async (params, ctx) => {
  const parsed = Schema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, error: 'invalid-params', details: parsed.error.flatten() }
  }
  const p = parsed.data
  const trimmedName = p.name

  const guild = ctx.client.guilds.cache.get(env.GUILD_ID)
    ?? await ctx.client.guilds.fetch(env.GUILD_ID).catch(() => null)
  if (!guild) {
    return { ok: false, error: 'guild-unavailable', details: env.GUILD_ID }
  }

  // Permission preflight — we need both ManageChannels and ManageRoles to
  // get through the full provisioning sequence. Failing fast saves a
  // partial create + rollback cycle.
  const me = guild.members.me
  if (me) {
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return { ok: false, error: 'missing-permissions', details: 'bot lacks ManageChannels' }
    }
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return { ok: false, error: 'missing-permissions', details: 'bot lacks ManageRoles' }
    }
  }

  // Idempotency: case-insensitive name match in the configured guild. Avoids
  // a duplicate-creation race between two panel users hitting "Auto-provision"
  // on the same name within the same minute.
  const existing = await db.select().from(games).where(
    and(
      eq(games.guildId, guild.id),
      sql`lower(${games.name}) = lower(${trimmedName})`,
    ),
  ).limit(1)
  if (existing.length > 0) {
    return {
      ok: false,
      error: 'game-exists',
      details: { gameId: existing[0].id, name: existing[0].name },
    }
  }

  // Resolve parent category. Caller-supplied wins; fall back to the
  // bot_settings key the rest of the games subsystem uses.
  const parentCategoryId = p.parentCategoryId
    ?? getSetting('channel.games_category')
    ?? undefined
  const position = p.position ?? DEFAULT_CHANNEL_POSITION
  const prefix = getSetting('channel.games_prefix') ?? DEFAULT_CHANNEL_PREFIX
  const channelName = `${prefix}${gameChannelSlug(trimmedName)}`.slice(0, 100)

  const created: { channelId?: string; viewRoleId?: string; pingRoleId?: string } = {}

  // Step 1: text channel inside the games category.
  try {
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: parentCategoryId,
      position,
      permissionOverwrites: [
        // Deny @everyone — per-member view overwrites gate access, mirroring
        // the existing `provisionGameDiscord` flow.
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
      ],
      reason: `game.provision channel for "${trimmedName}" (rid=${ctx.requestId})`,
    })
    created.channelId = channel.id
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === 50013) {
      return { ok: false, error: 'missing-permissions', details: err.message }
    }
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`game.provision: channel create failed for "${trimmedName}": ${msg}`)
    return { ok: false, error: 'discord-error', details: { step: 'channel', message: msg } }
  }

  // Step 2: view role (named after the game, non-mentionable, no perms).
  try {
    const viewRole = await guild.roles.create({
      name: trimmedName,
      color: p.viewRoleColor,
      hoist: false,
      mentionable: false,
      permissions: [],
      reason: `game.provision view role for "${trimmedName}" (rid=${ctx.requestId})`,
    })
    created.viewRoleId = viewRole.id
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`game.provision: view role create failed for "${trimmedName}": ${msg}`)
    await rollback(guild, created, 'view role create failed')
    if (err instanceof DiscordAPIError && err.code === 50013) {
      return { ok: false, error: 'missing-permissions', details: msg }
    }
    return { ok: false, error: 'discord-error', details: { step: 'view-role', message: msg } }
  }

  // Step 3: ping role (mentionable so /play and LFG pings work).
  try {
    const pingRole = await guild.roles.create({
      name: `${trimmedName} LFG`,
      color: p.pingRoleColor,
      hoist: false,
      mentionable: true,
      permissions: [],
      reason: `game.provision ping role for "${trimmedName}" (rid=${ctx.requestId})`,
    })
    created.pingRoleId = pingRole.id
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`game.provision: ping role create failed for "${trimmedName}": ${msg}`)
    await rollback(guild, created, 'ping role create failed')
    if (err instanceof DiscordAPIError && err.code === 50013) {
      return { ok: false, error: 'missing-permissions', details: msg }
    }
    return { ok: false, error: 'discord-error', details: { step: 'ping-role', message: msg } }
  }

  // Step 4: catalog row. `roleId` is left null — it's the legacy view-role
  // field the bot no longer reads; `pingRoleId` is the live ping role,
  // and we stash the view role on `roleId` too so it's not orphaned (the
  // schema doesn't have a dedicated view role column yet).
  try {
    const row = await createGame({
      guildId: guild.id,
      name: trimmedName,
      roleId: created.viewRoleId,
      pingRoleId: created.pingRoleId,
      channelId: created.channelId,
      categoryId: parentCategoryId ?? null,
      playCooldownSeconds: p.playCooldownSeconds ?? null,
      autoArchiveDays: p.autoArchiveDays ?? null,
    })
    // Refresh the in-memory catalog so the next /games / /play call sees the
    // new row without waiting for a manual `games.refresh_cache`.
    await loadGames().catch(err => logger.warn(`game.provision: loadGames refresh failed: ${(err as Error).message}`))

    logger.info(`game.provision: created game id=${row.id} name="${trimmedName}" channel=${created.channelId} view=${created.viewRoleId} ping=${created.pingRoleId}`)
    return {
      ok: true,
      data: {
        gameId: row.id,
        channelId: created.channelId!,
        viewRoleId: created.viewRoleId!,
        pingRoleId: created.pingRoleId!,
      },
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`game.provision: DB insert failed for "${trimmedName}": ${msg}`)
    await rollback(guild, created, 'DB insert failed')
    return { ok: false, error: 'db-error', details: msg }
  }
}

registerVerb('game.provision', provisionHandler)
