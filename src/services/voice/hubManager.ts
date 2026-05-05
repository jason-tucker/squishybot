import type { Client, Guild, GuildMember, VoiceChannel } from 'discord.js'
import { ChannelType } from 'discord.js'
import { db } from '../../db/client'
import { hubChannels, autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { generateChannelName } from '../../utils/channelName'
import { createAutoChannel } from './autoChannel'
import { logger } from '../logger'

export async function isHubChannel(channelId: string): Promise<boolean> {
  const [row] = await db.select().from(hubChannels).where(eq(hubChannels.channelId, channelId))
  return !!row
}

export async function seedHubsFromEnv(guild: Guild): Promise<void> {
  for (const channelId of env.HUB_CHANNEL_IDS) {
    const existing = await db.select().from(hubChannels).where(eq(hubChannels.channelId, channelId))
    if (existing.length > 0) continue

    const vc = await guild.channels.fetch(channelId).catch(() => null)
    if (!vc?.isVoiceBased()) {
      logger.warn(`Hub channel ${channelId} from HUB_CHANNEL_IDS not found in guild — skipping`)
      continue
    }

    await db.insert(hubChannels).values({
      guildId: guild.id,
      channelId: vc.id,
      categoryId: vc.parentId ?? env.AUTO_VOICE_CATEGORY_ID,
      position: vc.position,
      label: vc.name,
    })
    logger.info(`Registered hub: ${vc.name} (${channelId})`)
  }
}

export async function handleHubJoin(client: Client, guild: Guild, member: GuildMember, hubChannelId: string): Promise<void> {
  const [hubRecord] = await db.select().from(hubChannels).where(eq(hubChannels.channelId, hubChannelId))
  if (!hubRecord) return

  const hubVc = await guild.channels.fetch(hubChannelId).catch(() => null) as VoiceChannel | null
  if (!hubVc?.isVoiceBased()) return

  // Collect existing auto channel names to avoid collisions
  const existingRecords = await db.select({ voiceChannelId: autoChannels.voiceChannelId }).from(autoChannels)
  const existingNames: string[] = []
  for (const r of existingRecords) {
    const vc = await guild.channels.fetch(r.voiceChannelId).catch(() => null)
    if (vc) existingNames.push(vc.name)
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
}

async function createReplacementHub(guild: Guild, originalHub: typeof hubChannels.$inferSelect): Promise<void> {
  try {
    const newHub = await guild.channels.create({
      name: originalHub.label,
      type: ChannelType.GuildVoice,
      parent: originalHub.categoryId,
      position: originalHub.position,
    })

    await db.update(hubChannels)
      .set({ channelId: newHub.id })
      .where(eq(hubChannels.id, originalHub.id))

    logger.info(`Replacement hub created: ${newHub.name} (${newHub.id})`)
  } catch (err) {
    logger.error('Failed to create replacement hub:', err)
  }
}
