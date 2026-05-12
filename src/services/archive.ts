/**
 * Channel archive workflow — manual, sudo-driven, opt-in.
 *
 * Sudo marks specific Discord categories as "archive-eligible" via
 * /sudo → Settings → Archive. Channels in those categories are scannable
 * for staleness (no message in `archive.stale_days` days; default 90).
 * The scan produces a list with last-message timestamps; sudo picks which
 * to archive. Archive action: move to the configured destination category,
 * deny @everyone Send (View stays open so history is readable), prepend
 * 🗄️ to the name. Reversible — `unarchiveChannel` restores the original
 * parent + name and clears the Send deny.
 *
 * Settings keys consulted (all live in bot_settings, editable via /sudo):
 *   channel.archive_destination — category ID to move into when archiving
 *   archive.stale_days          — int, default 90
 */
import { ChannelType, type Client, type TextChannel } from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import {
  archiveEligibleCategories,
  archivedChannels,
  autoChannels,
  hubChannels,
} from '../db/schema'
import { getSetting, settingOrNumber } from './settings'
import { logger } from './logger'

const ARCHIVE_PREFIX = '🗄️-'
const DEFAULT_STALE_DAYS = 90

export function getStaleDays(): number {
  return Math.max(1, settingOrNumber('archive.stale_days', DEFAULT_STALE_DAYS))
}

export function getArchiveDestinationCategoryId(): string | null {
  return getSetting('channel.archive_destination')
}

// ---------------------------------------------------------------------------
// Eligible categories — sudo-managed opt-in list
// ---------------------------------------------------------------------------

export async function listEligibleCategories(guildId: string): Promise<string[]> {
  const rows = await db.select().from(archiveEligibleCategories).where(eq(archiveEligibleCategories.guildId, guildId))
  return rows.map(r => r.categoryId)
}

export async function addEligibleCategory(guildId: string, categoryId: string, byUserId?: string): Promise<void> {
  await db.insert(archiveEligibleCategories)
    .values({ guildId, categoryId, addedByUserId: byUserId ?? null })
    .onConflictDoNothing({ target: archiveEligibleCategories.categoryId })
}

export async function removeEligibleCategory(categoryId: string): Promise<void> {
  await db.delete(archiveEligibleCategories).where(eq(archiveEligibleCategories.categoryId, categoryId))
}

// ---------------------------------------------------------------------------
// Scan — find stale channels inside eligible categories
// ---------------------------------------------------------------------------

export interface StaleChannel {
  channelId: string
  name: string
  categoryId: string
  lastMessageAt: Date | null  // null = no messages ever (or unreachable)
}

/**
 * Returns text-based channels inside eligible categories whose latest
 * message is older than the configured threshold. Auto-channel text
 * channels and hub voice channels are excluded — those are managed by
 * the bot and shouldn't be archived. Non-text channels (voice/forum/etc.)
 * are skipped: this is text-channel staleness only.
 */
export async function scanStaleChannels(client: Client, guildId: string): Promise<StaleChannel[]> {
  const guild = client.guilds.cache.get(guildId)
  if (!guild) return []

  const eligibleIds = new Set(await listEligibleCategories(guildId))
  if (eligibleIds.size === 0) return []

  // Build the exclusion list of bot-managed channels.
  const [autoRows, hubRows] = await Promise.all([
    db.select({ textChannelId: autoChannels.textChannelId, voiceChannelId: autoChannels.voiceChannelId }).from(autoChannels),
    db.select({ channelId: hubChannels.channelId }).from(hubChannels),
  ])
  const excluded = new Set<string>()
  for (const r of autoRows) { excluded.add(r.textChannelId); excluded.add(r.voiceChannelId) }
  for (const r of hubRows)  { excluded.add(r.channelId) }

  // Also skip channels already in the archived table.
  const archivedRows = await db.select({ channelId: archivedChannels.channelId }).from(archivedChannels)
    .where(eq(archivedChannels.guildId, guildId))
  for (const r of archivedRows) excluded.add(r.channelId)

  const staleCutoff = Date.now() - getStaleDays() * 24 * 60 * 60 * 1000
  const out: StaleChannel[] = []

  for (const [, channel] of guild.channels.cache) {
    if (excluded.has(channel.id)) continue
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) continue
    if (!channel.parentId || !eligibleIds.has(channel.parentId)) continue

    // Try to read the last message's timestamp. lastMessageId is cached; if
    // unset, fetch the most recent message in the channel as a fallback.
    let lastAt: Date | null = null
    const lastId = (channel as TextChannel).lastMessageId
    if (lastId) {
      try {
        // Discord snowflakes encode a creation timestamp: ((id >> 22) + EPOCH).
        const ms = Number((BigInt(lastId) >> 22n) + 1420070400000n)
        if (Number.isFinite(ms)) lastAt = new Date(ms)
      } catch {
        // ignore
      }
    }
    if (!lastAt) {
      try {
        const msgs = await (channel as TextChannel).messages.fetch({ limit: 1 })
        const first = msgs.first()
        if (first) lastAt = first.createdAt
      } catch (err) {
        logger.warn(`scanStaleChannels: failed to fetch latest message for ${channel.id}: ${(err as Error).message}`)
      }
    }

    // A channel with no messages ever (lastAt still null) is considered stale.
    if (lastAt === null || lastAt.getTime() < staleCutoff) {
      out.push({
        channelId: channel.id,
        name: channel.name,
        categoryId: channel.parentId,
        lastMessageAt: lastAt,
      })
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Archive / unarchive actions
// ---------------------------------------------------------------------------

export async function archiveChannel(client: Client, guildId: string, channelId: string, byUserId?: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const guild = client.guilds.cache.get(guildId)
  if (!guild) return { ok: false, reason: 'guild not in cache' }

  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null)
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    return { ok: false, reason: 'channel missing or not a text channel' }
  }

  // Block re-archiving a row that's already archived.
  const [existing] = await db.select().from(archivedChannels).where(eq(archivedChannels.channelId, channelId))
  if (existing) return { ok: false, reason: 'already archived' }

  const destinationCategoryId = getArchiveDestinationCategoryId()
  if (!destinationCategoryId) return { ok: false, reason: 'destination category not configured (set channel.archive_destination)' }

  const destinationCategory = guild.channels.cache.get(destinationCategoryId)
  if (!destinationCategory || destinationCategory.type !== ChannelType.GuildCategory) {
    return { ok: false, reason: 'destination category not found in guild' }
  }

  const originalName = channel.name
  const originalCategoryId = channel.parentId

  // Persist BEFORE mutating Discord so a crash mid-archive doesn't strand the channel
  // without a way to unarchive it (we'd lose the original name + parent otherwise).
  await db.insert(archivedChannels).values({
    channelId,
    guildId,
    originalCategoryId: originalCategoryId ?? null,
    originalName,
    archivedByUserId: byUserId ?? null,
  })

  const newName = (ARCHIVE_PREFIX + originalName).slice(0, 100)

  try {
    // Narrow: archiveChannel guards type === GuildText | GuildAnnouncement above,
    // both of which have .edit({ name, parent }).
    await channel.edit({
      name: newName,
      parent: destinationCategoryId,
    })
    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: false,
      AddReactions: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false,
    })
  } catch (err) {
    // Rollback the DB row so the Unarchive list doesn't reference a half-archived channel.
    await db.delete(archivedChannels).where(eq(archivedChannels.channelId, channelId)).catch(() => {})
    return { ok: false, reason: `Discord edit failed: ${(err as Error).message}` }
  }

  logger.info(`Archived channel ${channelId} (${originalName}) by ${byUserId ?? 'unknown'}`)
  return { ok: true }
}

export async function unarchiveChannel(client: Client, channelId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [row] = await db.select().from(archivedChannels).where(eq(archivedChannels.channelId, channelId))
  if (!row) return { ok: false, reason: 'not archived' }

  const guild = client.guilds.cache.get(row.guildId)
  if (!guild) return { ok: false, reason: 'guild not in cache' }

  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null)
  if (!channel) {
    // Channel deleted out from under us. Just clear the row.
    await db.delete(archivedChannels).where(eq(archivedChannels.channelId, channelId))
    return { ok: false, reason: 'channel no longer exists in Discord (DB row cleared)' }
  }
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return { ok: false, reason: 'channel is not a text/announcement channel (cannot unarchive threads / voice)' }
  }

  try {
    await channel.edit({
      name: row.originalName,
      parent: row.originalCategoryId,
    })
    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: null,
      AddReactions: null,
      CreatePublicThreads: null,
      CreatePrivateThreads: null,
      SendMessagesInThreads: null,
    })
  } catch (err) {
    return { ok: false, reason: `Discord edit failed: ${(err as Error).message}` }
  }

  await db.delete(archivedChannels).where(eq(archivedChannels.channelId, channelId))
  logger.info(`Unarchived channel ${channelId} (${row.originalName})`)
  return { ok: true }
}

export async function listArchived(guildId: string): Promise<{ channelId: string; originalName: string; archivedAt: Date }[]> {
  const rows = await db.select().from(archivedChannels).where(eq(archivedChannels.guildId, guildId))
  return rows.map(r => ({ channelId: r.channelId, originalName: r.originalName, archivedAt: r.archivedAt }))
}

// Make this importable for batch archive in the UI
export { ARCHIVE_PREFIX }
