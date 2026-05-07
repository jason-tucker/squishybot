import type { Client, Guild, GuildMember, VoiceChannel } from 'discord.js'
import { ChannelType, PermissionFlagsBits, OverwriteType } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { getSetting, trackAutoChannelText, untrackAutoChannelText } from '../settings'
import type { AutoChannelRecord } from '../../types/voice'
import { postOrUpdateControlPanel } from './controlPanel'
import { postOrUpdateSticky } from './sticky'
import { scheduleCleanup, cancelCleanup } from './cleanupScheduler'
import { cancelAllHideGracesFor } from './hideGrace'
import { logger } from '../logger'

export async function createAutoChannel(
  client: Client,
  guild: Guild,
  owner: GuildMember,
  existingVoiceChannel: VoiceChannel,
  sourceHubId: string,
  channelName: string,
): Promise<AutoChannelRecord | null> {
  const botId = client.user!.id

  // 1. Rename the existing hub voice channel and move it to position 0 (top of category)
  await existingVoiceChannel.edit({ name: channelName, position: 0 }).catch(err =>
    logger.warn('Failed to rename/reposition hub channel in place:', err)
  )

  // 2. Create the attached text channel at position 0 (top of category, same name as voice)
  const textChannelName = channelName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice-chat'
  let textChannel
  try {
    textChannel = await guild.channels.create({
      name: textChannelName,
      type: ChannelType.GuildText,
      parent: getSetting('channel.auto_voice_category') ?? env.AUTO_VOICE_CATEGORY_ID,
      position: 0,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel], type: OverwriteType.Role },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory], type: OverwriteType.Member },
        { id: owner.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory], type: OverwriteType.Member },
        ...env.SUDO_ROLE_IDS.map(roleId => ({
          id: roleId,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory],
          type: OverwriteType.Role as const,
        })),
      ],
    })
  } catch (err) {
    logger.error('Failed to create text channel for auto voice:', err)
    return null
  }

  // 3. Insert DB record
  const [record] = await db.insert(autoChannels).values({
    guildId: guild.id,
    voiceChannelId: existingVoiceChannel.id,
    textChannelId: textChannel.id,
    ownerUserId: owner.id,
    sourceHubId,
  }).returning()
  trackAutoChannelText(record.textChannelId)

  // 4. Post control panel + sticky
  await postOrUpdateControlPanel(client, record)
  await postOrUpdateSticky(client, record)

  logger.info(`Auto channel created: ${channelName} (vc=${existingVoiceChannel.id}, tc=${textChannel.id})`)
  return record
}

export async function deleteAutoChannel(client: Client, record: AutoChannelRecord): Promise<void> {
  const guild = client.guilds.cache.get(record.guildId)
  if (!guild) return

  cancelCleanup(record.voiceChannelId)
  cancelAllHideGracesFor(record.voiceChannelId)

  await Promise.all([
    guild.channels.delete(record.voiceChannelId).catch(() => {}),
    guild.channels.delete(record.textChannelId).catch(() => {}),
  ])

  await db.delete(autoChannels).where(eq(autoChannels.voiceChannelId, record.voiceChannelId)).catch(() => {})
  untrackAutoChannelText(record.textChannelId)

  logger.info(`Auto channel deleted: vc=${record.voiceChannelId}`)
}
