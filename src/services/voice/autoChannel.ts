import type { Client, Guild, GuildMember, VoiceChannel } from 'discord.js'
import { ChannelType, PermissionFlagsBits, OverwriteType } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { getHubInfo, getSetting, trackAutoChannelText, trackAutoChannelVoice, untrackAutoChannelText, untrackAutoChannelVoice } from '../settings'
import type { AutoChannelRecord } from '../../types/voice'
import { postOrUpdateControlPanel, clearPanelHash, cancelPanelRefresh } from './controlPanel'
import { postOrUpdateSticky } from './sticky'
import { scheduleCleanup, cancelCleanup } from './cleanupScheduler'
import { cancelAllHideGracesFor } from './hideGrace'
import { clearMembers, recordMemberJoin } from './voiceMembers'
import { clearRenameThrottle } from '../../bot/events/presenceUpdate'
import { clearStickyDebounce } from '../../bot/events/messageCreate'
import { logger } from '../logger'
import { publish, voiceCh, type VoiceChannelCreatedEvent, type VoiceChannelDeletedEvent } from '../eventBus'

export async function createAutoChannel(
  client: Client,
  guild: Guild,
  owner: GuildMember,
  existingVoiceChannel: VoiceChannel,
  sourceHubId: string,
  channelName: string,
): Promise<AutoChannelRecord | null> {
  const botId = client.user!.id

  // Per-hub defaults override the bot's built-in defaults. {member} in the
  // manual name template substitutes to the joiner's display name. Each
  // field is independent: any combination can be null.
  const hubDefaults = getHubInfo(sourceHubId)
  const overrideManualName = hubDefaults?.defaultManualName
    ? hubDefaults.defaultManualName.replace(/\{member\}/gi, owner.displayName).slice(0, 100)
    : null
  const effectiveName = overrideManualName ?? channelName
  const effectiveUserLimit = hubDefaults?.defaultUserLimit ?? 0

  // 1. Rename the existing hub voice channel and move it to position 0 (top of category).
  // userLimit is bundled into this edit so it takes effect immediately if a hub default applies.
  await existingVoiceChannel.edit({ name: effectiveName, position: 0, userLimit: effectiveUserLimit }).catch(err =>
    logger.warn('Failed to rename/reposition hub channel in place:', err)
  )

  // 2. Create the attached text channel at position 0 (top of category, same name as voice)
  const textChannelName = effectiveName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice-chat'
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

  // 3. Insert DB record. Guarded with a try/catch because the unique
  //    constraint on voice_channel_id can fire when a parallel hub-join
  //    raced ahead of us (see hubManager). On collision we delete the
  //    half-created text channel so we don't leak an orphan.
  let record: AutoChannelRecord
  try {
    const [row] = await db.insert(autoChannels).values({
      guildId: guild.id,
      voiceChannelId: existingVoiceChannel.id,
      textChannelId: textChannel.id,
      ownerUserId: owner.id,
      sourceHubId,
      fallbackName: effectiveName,
      // Per-hub defaults flow into the auto-channel record so they survive
      // reboots and panel renders show the right template + state.
      nameTemplate: hubDefaults?.defaultTemplateKey ?? null,
      manualName: overrideManualName,
      userLimit: effectiveUserLimit,
      // Hub-pinned manual name implies the user picked their fixed name —
      // auto-rename shouldn't churn it on presence changes.
      autoNameEnabled: !overrideManualName,
    }).returning()
    record = row
  } catch (err: any) {
    if (err?.cause?.code === '23505' || err?.code === '23505') {
      logger.warn(`createAutoChannel: voice_channel_id=${existingVoiceChannel.id} already exists — likely a concurrent hub join. Cleaning up half-created text channel.`)
      await textChannel.delete().catch(() => {})
      return null
    }
    throw err
  }
  trackAutoChannelText(record.textChannelId)
  trackAutoChannelVoice(record.voiceChannelId, record.textChannelId)

  // Record the joining owner in the members table so the panel shows them
  // immediately. voiceStateUpdate fires for them too but the order isn't
  // guaranteed relative to the panel's first render.
  await recordMemberJoin(record.voiceChannelId, owner.id, guild.id)

  // 4. Post control panel + sticky. Pass the freshly-created textChannel so
  // we don't depend on the bot's channel cache having caught up to the create.
  await postOrUpdateControlPanel(client, record, textChannel)
  await postOrUpdateSticky(client, record)

  logger.info(`Auto channel created: ${channelName} (vc=${existingVoiceChannel.id}, tc=${textChannel.id})`)

  void publish<VoiceChannelCreatedEvent>(voiceCh('channel_created'), {
    voiceChannelId: record.voiceChannelId,
    textChannelId: record.textChannelId,
    ownerUserId: record.ownerUserId,
    name: effectiveName,
    ts: new Date().toISOString(),
  })

  return record
}

export async function deleteAutoChannel(client: Client, record: AutoChannelRecord): Promise<void> {
  const guild = client.guilds.cache.get(record.guildId)
  if (!guild) return

  cancelCleanup(record.voiceChannelId)
  cancelAllHideGracesFor(record.voiceChannelId)
  clearRenameThrottle(record.voiceChannelId)
  cancelPanelRefresh(record.voiceChannelId)
  clearStickyDebounce(record.textChannelId)
  clearPanelHash(record.voiceChannelId)

  await Promise.all([
    guild.channels.delete(record.voiceChannelId).catch(() => {}),
    guild.channels.delete(record.textChannelId).catch(() => {}),
  ])

  await db.delete(autoChannels).where(eq(autoChannels.voiceChannelId, record.voiceChannelId)).catch(() => {})
  await clearMembers(record.voiceChannelId)
  untrackAutoChannelText(record.textChannelId)
  untrackAutoChannelVoice(record.voiceChannelId)

  logger.info(`Auto channel deleted: vc=${record.voiceChannelId}`)

  void publish<VoiceChannelDeletedEvent>(voiceCh('channel_deleted'), {
    voiceChannelId: record.voiceChannelId,
    textChannelId: record.textChannelId,
    ownerUserId: record.ownerUserId,
    name: record.fallbackName ?? '',
    ts: new Date().toISOString(),
  })
}
