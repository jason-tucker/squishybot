import type { Client, Guild, GuildMember, VoiceChannel } from 'discord.js'
import { ChannelType, PermissionFlagsBits, OverwriteType } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import type { AutoChannelRecord } from '../../types/voice'
import { postOrUpdateControlPanel } from './controlPanel'
import { scheduleCleanup, cancelCleanup } from './cleanupScheduler'
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

  // 1. Rename the existing hub voice channel in place (owner already in it)
  await existingVoiceChannel.setName(channelName).catch(err =>
    logger.warn('Failed to rename hub channel in place:', err)
  )

  // 2. Create the attached text channel below the voice channel
  let textChannel
  try {
    textChannel = await guild.channels.create({
      name: channelName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      type: ChannelType.GuildText,
      parent: env.AUTO_VOICE_CATEGORY_ID,
      position: existingVoiceChannel.position + 1,
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

  // 4. Post control panel
  await postOrUpdateControlPanel(client, record)

  logger.info(`Auto channel created: ${channelName} (vc=${existingVoiceChannel.id}, tc=${textChannel.id})`)
  return record
}

export async function deleteAutoChannel(client: Client, record: AutoChannelRecord): Promise<void> {
  const guild = client.guilds.cache.get(record.guildId)
  if (!guild) return

  cancelCleanup(record.voiceChannelId)

  await Promise.all([
    guild.channels.delete(record.voiceChannelId).catch(() => {}),
    guild.channels.delete(record.textChannelId).catch(() => {}),
  ])

  await db.delete(autoChannels).where(eq(autoChannels.voiceChannelId, record.voiceChannelId)).catch(() => {})

  logger.info(`Auto channel deleted: vc=${record.voiceChannelId}`)
}
