import type { Client, Guild, GuildMember, VoiceChannel } from 'discord.js'
import { ChannelType } from 'discord.js'
import { db } from '../../db/client'
import { hubChannels, autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { generateChannelName } from '../../utils/channelName'
import { createAutoChannel } from './autoChannel'
import { logger } from '../logger'
import {
  getSetting,
  isHubChannelCached,
  listAutoChannelVoiceIds,
  registerHubChannel,
  updateHubChannelId,
} from '../settings'

export function isHubChannel(channelId: string): boolean {
  return isHubChannelCached(channelId)
}

/**
 * Seed hubs from `HUB_CHANNEL_IDS` env var. Legacy compatibility — the
 * authoritative source is now the `hub_channels` table managed via
 * `/sudo → Settings → Hub Channels`. Skipped entirely when the env list is empty.
 */
export async function seedHubsFromEnv(guild: Guild): Promise<void> {
  if (env.HUB_CHANNEL_IDS.length === 0) return

  for (const channelId of env.HUB_CHANNEL_IDS) {
    if (isHubChannelCached(channelId)) continue

    const vc = await guild.channels.fetch(channelId).catch(() => null)
    if (!vc?.isVoiceBased()) {
      logger.warn(`Hub channel ${channelId} from HUB_CHANNEL_IDS not found in guild — skipping`)
      continue
    }

    // If this channel is currently an auto channel (renamed from a hub), don't
    // re-register it as a hub. This prevents corruption where the env still has
    // the original hub ID but the actual hub has been replaced and the original
    // channel is now a user's room.
    const [auto] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, channelId))
    if (auto) {
      logger.warn(`HUB_CHANNEL_IDS contains ${channelId} but it's an active auto channel — skipping. Update HUB_CHANNEL_IDS to the current hub.`)
      continue
    }

    await registerHubChannel({
      guildId: guild.id,
      channelId: vc.id,
      categoryId: vc.parentId ?? getSetting('channel.auto_voice_category') ?? env.AUTO_VOICE_CATEGORY_ID,
      position: vc.position,
      label: vc.name,
    })
    logger.info(`Registered hub from env: ${vc.name} (${channelId})`)
  }
}

// Per-hub lock — guards against two voiceStateUpdate events racing through
// handleHubJoin for the same hub before the cache flips to the replacement.
// Without this the second invocation hits the unique constraint on
// auto_channels.voice_channel_id and throws.
const handlingHubs = new Set<string>()

export async function handleHubJoin(client: Client, guild: Guild, member: GuildMember, hubChannelId: string): Promise<void> {
  // Feature flag (#33): bot owner can disable auto-voice creation. Existing
  // channels keep working; new hub joins just no-op.
  const { getBoolSetting } = await import('../settings')
  if (!getBoolSetting('feature.auto_voice', true)) {
    logger.info(`Auto-voice disabled (feature flag) — ignoring hub join from ${member.id} on ${hubChannelId}`)
    return
  }

  // Idempotency: if the hub has already been promoted to an auto channel
  // (created moments ago by a parallel join), do nothing here. The earlier
  // auto_channels check in voiceStateUpdate is the primary guard; this
  // double-checks in case the lookup-then-insert window was crossed by yet
  // another concurrent event.
  const [existing] = await db.select().from(autoChannels)
    .where(eq(autoChannels.voiceChannelId, hubChannelId))
  if (existing) {
    logger.warn(`handleHubJoin: ${hubChannelId} is already an auto channel — skipping concurrent hub join from ${member.id}`)
    return
  }

  if (handlingHubs.has(hubChannelId)) {
    logger.warn(`handleHubJoin: ${hubChannelId} already being processed — skipping concurrent join from ${member.id}`)
    return
  }
  handlingHubs.add(hubChannelId)

  try {
    const [hubRecord] = await db.select().from(hubChannels).where(eq(hubChannels.channelId, hubChannelId))
    if (!hubRecord) return

    const hubVc = await guild.channels.fetch(hubChannelId).catch(() => null) as VoiceChannel | null
    if (!hubVc?.isVoiceBased()) return

    // Collect existing auto channel names to avoid collisions. Read names
    // straight from guild.channels.cache (always populated when the bot has
    // the Guilds intent, which it does) instead of awaiting one fetch per
    // record — we'd otherwise serialize N microtask hops on every hub join.
    // The ID set comes from the in-memory auto-channel cache (kept in
    // lockstep with auto_channels by the lifecycle hooks), skipping what was
    // a full-table query per hub join; it only feeds name de-duplication, so
    // even a momentarily stale entry is cosmetic.
    const existingIds = new Set(listAutoChannelVoiceIds())
    const existingNames: string[] = []
    for (const ch of guild.channels.cache.values()) {
      if (existingIds.has(ch.id) && 'name' in ch) existingNames.push(ch.name)
    }

    const channelName = generateChannelName(member, existingNames)

    // Create the auto channel (renames hub in place, creates text channel)
    const record = await createAutoChannel(client, guild, member, hubVc, hubChannelId, channelName)
    if (!record) {
      logger.error(`Failed to create auto channel for ${member.displayName}`)
      return
    }

    // Create replacement hub in same category
    await createReplacementHub(guild, hubRecord)
  } finally {
    handlingHubs.delete(hubChannelId)
  }
}

async function createReplacementHub(guild: Guild, originalHub: typeof hubChannels.$inferSelect): Promise<void> {
  try {
    const newHub = await guild.channels.create({
      name: originalHub.label,
      type: ChannelType.GuildVoice,
      parent: originalHub.categoryId,
      position: originalHub.position,
    })

    // Update the cache *before* the DB write so a voiceStateUpdate for someone
    // joining the new hub immediately is recognized as a hub join.
    updateHubChannelId(originalHub.channelId, newHub.id)
    await db.update(hubChannels)
      .set({ channelId: newHub.id })
      .where(eq(hubChannels.id, originalHub.id))

    logger.info(`Replacement hub created: ${newHub.name} (${newHub.id})`)
  } catch (err) {
    logger.error('Failed to create replacement hub:', err)
  }
}
