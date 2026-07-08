import type { Client, Guild, GuildMember, VoiceChannel } from 'discord.js'
import { ChannelType, PermissionFlagsBits, OverwriteType, ActivityType } from 'discord.js'
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
import { clearChannelLog, logChannelEvent } from './channelLog'
import { plainChannelName } from './autoNaming'
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

  // A freshly-created room is NOT named after a game, so it gets NO emoji — just
  // a collision-dodging name. The game emoji is only added later if Smart
  // auto-naming renames the room to a game 2+ members share. `effectiveName`
  // (undecorated) is persisted as `fallback_name` so later renames start clean.
  const displayName = plainChannelName(guild, effectiveName, existingVoiceChannel.id)

  // 1. Rename the existing hub voice channel and move it to position 0 (top of category).
  // userLimit is bundled into this edit so it takes effect immediately if a hub default applies.
  await existingVoiceChannel.edit({ name: displayName, position: 0, userLimit: effectiveUserLimit }).catch(err =>
    logger.warn('Failed to rename/reposition hub channel in place:', err)
  )

  // 2. Create the attached text channel at position 0 (top of category, same name as voice)
  const textChannel = await createTextChannelForVoice(guild, botId, owner, displayName)
  if (!textChannel) return null

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
  logChannelEvent({ voiceChannelId: record.voiceChannelId, guildId: guild.id, type: 'created', actorUserId: owner.id })
  const ownerGame = owner.presence?.activities.find(a => a.type === ActivityType.Playing)?.name ?? null
  if (ownerGame) logChannelEvent({ voiceChannelId: record.voiceChannelId, guildId: guild.id, type: 'game_start', actorUserId: owner.id, detail: ownerGame })

  // 4. Post control panel + sticky. Pass the freshly-created textChannel so
  // we don't depend on the bot's channel cache having caught up to the create.
  await postOrUpdateControlPanel(client, record, textChannel)
  await postOrUpdateSticky(client, record)

  logger.info(`Auto channel created: ${channelName} (vc=${existingVoiceChannel.id}, tc=${textChannel.id})`)

  void publish<VoiceChannelCreatedEvent>(voiceCh('channel_created'), {
    voiceChannelId: record.voiceChannelId,
    textChannelId: record.textChannelId,
    ownerUserId: record.ownerUserId,
    name: displayName,
    ts: new Date().toISOString(),
  })

  return record
}

/**
 * Shared helper — creates only the text channel (no VC rename, no hub
 * replacement). Used by both createAutoChannel and createStaticChannelText.
 */
async function createTextChannelForVoice(
  guild: Guild,
  botId: string,
  owner: GuildMember,
  displayName: string,
): Promise<import('discord.js').TextChannel | null> {
  const textChannelName = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice-chat'
  try {
    const tc = await guild.channels.create({
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
    return tc as import('discord.js').TextChannel
  } catch (err) {
    logger.error('Failed to create text channel for auto voice:', err)
    return null
  }
}

/**
 * Creates a companion text channel + DB record + control panel for a STATIC
 * voice channel. The VC is not renamed, not replaced, and will never be
 * deleted by the bot. Only the companion text channel follows the cleanup
 * lifecycle (deleted when empty; VC stays).
 *
 * Uses the sentinel `sourceHubId: 'static'` in the auto_channels row —
 * no migration, no new column.
 *
 * Returns null if creation fails or if the VC already has an active record.
 */
export async function createStaticChannelText(
  client: Client,
  guild: Guild,
  owner: GuildMember,
  staticVc: VoiceChannel,
): Promise<AutoChannelRecord | null> {
  const botId = client.user!.id
  const displayName = staticVc.name

  const textChannel = await createTextChannelForVoice(guild, botId, owner, displayName)
  if (!textChannel) return null

  let record: AutoChannelRecord
  try {
    const [row] = await db.insert(autoChannels).values({
      guildId: guild.id,
      voiceChannelId: staticVc.id,
      textChannelId: textChannel.id,
      ownerUserId: owner.id,
      sourceHubId: 'static',
      fallbackName: displayName,
      nameTemplate: null,
      manualName: null,
      userLimit: staticVc.userLimit ?? 0,
      autoNameEnabled: false,
    }).returning()
    record = row
  } catch (err: any) {
    if (err?.cause?.code === '23505' || err?.code === '23505') {
      logger.warn(`createStaticChannelText: voice_channel_id=${staticVc.id} already has an active record — cleanup race. Removing half-created text channel.`)
      await textChannel.delete().catch(() => {})
      return null
    }
    throw err
  }
  trackAutoChannelText(record.textChannelId)
  trackAutoChannelVoice(record.voiceChannelId, record.textChannelId)

  await recordMemberJoin(record.voiceChannelId, owner.id, guild.id)
  logChannelEvent({ voiceChannelId: record.voiceChannelId, guildId: guild.id, type: 'created', actorUserId: owner.id })
  const ownerGame = owner.presence?.activities.find(a => a.type === ActivityType.Playing)?.name ?? null
  if (ownerGame) logChannelEvent({ voiceChannelId: record.voiceChannelId, guildId: guild.id, type: 'game_start', actorUserId: owner.id, detail: ownerGame })
  await postOrUpdateControlPanel(client, record, textChannel)
  await postOrUpdateSticky(client, record)

  logger.info(`Static channel text created: vc=${staticVc.id} tc=${textChannel.id} owner=${owner.id}`)

  void publish<VoiceChannelCreatedEvent>(voiceCh('channel_created'), {
    voiceChannelId: record.voiceChannelId,
    textChannelId: record.textChannelId,
    ownerUserId: record.ownerUserId,
    name: displayName,
    ts: new Date().toISOString(),
  })

  return record
}

/**
 * Deletes ONLY the companion text channel (and the DB row) for a static VC.
 * The voice channel itself is left untouched.
 */
export async function deleteStaticText(client: Client, record: AutoChannelRecord): Promise<void> {
  const guild = client.guilds.cache.get(record.guildId)
  if (!guild) return

  cancelCleanup(record.voiceChannelId)
  cancelAllHideGracesFor(record.voiceChannelId)
  clearRenameThrottle(record.voiceChannelId)
  cancelPanelRefresh(record.voiceChannelId)
  clearStickyDebounce(record.textChannelId)
  clearPanelHash(record.voiceChannelId)

  // Delete only the text channel; leave the VC alone.
  await guild.channels.delete(record.textChannelId).catch(() => {})

  await db.delete(autoChannels).where(eq(autoChannels.voiceChannelId, record.voiceChannelId)).catch(() => {})
  await clearMembers(record.voiceChannelId)
  await clearChannelLog(record.voiceChannelId)
  untrackAutoChannelText(record.textChannelId)
  untrackAutoChannelVoice(record.voiceChannelId)

  logger.info(`Static channel text deleted (VC kept): vc=${record.voiceChannelId} tc=${record.textChannelId}`)

  void publish<VoiceChannelDeletedEvent>(voiceCh('channel_deleted'), {
    voiceChannelId: record.voiceChannelId,
    textChannelId: record.textChannelId,
    ownerUserId: record.ownerUserId,
    name: record.fallbackName ?? '',
    ts: new Date().toISOString(),
  })
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
  await clearChannelLog(record.voiceChannelId)
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
