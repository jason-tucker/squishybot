import type { Client, TextChannel, VoiceBasedChannel } from 'discord.js'
import { ActivityType } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import {
  buildControlPanelPayload,
  type MemberPresenceInfo,
} from '../../embeds/voiceControlPanel'
import type { AutoChannelRecord } from '../../types/voice'
import { listMembers } from './voiceMembers'
import { logger } from '../logger'

export async function buildPanelPayloadForRecord(client: Client, record: AutoChannelRecord) {
  const [{ ownerTag, hostTags }, members] = await Promise.all([
    resolveDisplayTags(client, record),
    resolveMembersWithPresence(client, record.voiceChannelId),
  ])
  return buildControlPanelPayload(record, ownerTag, hostTags, members)
}

async function resolveDisplayTags(client: Client, record: AutoChannelRecord): Promise<{ ownerTag: string; hostTags: string[] }> {
  const guild = client.guilds.cache.first()
  if (!guild) return { ownerTag: `<@${record.ownerUserId}>`, hostTags: record.hostUserIds.map(id => `<@${id}>`) }

  const ownerMember = await guild.members.fetch(record.ownerUserId).catch(() => null)
  const ownerTag = ownerMember ? ownerMember.displayName : `<@${record.ownerUserId}>`

  const hostTags = await Promise.all(
    record.hostUserIds.map(async id => {
      const m = await guild.members.fetch(id).catch(() => null)
      return m ? m.displayName : `<@${id}>`
    })
  )

  return { ownerTag, hostTags }
}

/** Pull the DB join rows and overlay each user's current "Playing X" activity. */
async function resolveMembersWithPresence(client: Client, voiceChannelId: string): Promise<MemberPresenceInfo[]> {
  const rows = await listMembers(voiceChannelId)
  const guild = client.guilds.cache.first()
  return rows.map(r => {
    const member = guild?.members.cache.get(r.userId)
    const game = member?.presence?.activities.find(a => a.type === ActivityType.Playing)?.name ?? null
    return { userId: r.userId, joinedAt: r.joinedAt, game }
  })
}

/**
 * Post the panel for a fresh channel, or edit-in-place if a tracked panel
 * already exists. `prefetchedTextChannel` lets callers (createAutoChannel)
 * skip the channels.fetch round-trip — important right after creation when
 * the bot's channel cache may not yet contain the new ID.
 */
export async function postOrUpdateControlPanel(
  client: Client,
  record: AutoChannelRecord,
  prefetchedTextChannel?: TextChannel,
): Promise<void> {
  const guild = client.guilds.cache.first()
  if (!guild) {
    logger.warn(`postOrUpdateControlPanel: no guild in cache for vc=${record.voiceChannelId}`)
    return
  }

  let textChannel: TextChannel | null = prefetchedTextChannel ?? null
  if (!textChannel) {
    const fetched = await guild.channels.fetch(record.textChannelId).catch(() => null)
    if (!fetched || !fetched.isTextBased()) {
      logger.warn(`postOrUpdateControlPanel: text channel ${record.textChannelId} unavailable (vc=${record.voiceChannelId})`)
      return
    }
    textChannel = fetched as TextChannel
  }

  const [{ ownerTag, hostTags }, members] = await Promise.all([
    resolveDisplayTags(client, record),
    resolveMembersWithPresence(client, record.voiceChannelId),
  ])
  const payload = buildControlPanelPayload(record, ownerTag, hostTags, members)

  if (record.controlPanelMsgId) {
    const existing = await textChannel.messages.fetch(record.controlPanelMsgId).catch(() => null)
    if (existing) {
      const editErr = await existing.edit({ ...payload, content: null } as any).then(() => null).catch(err => err)
      if (editErr) logger.error(`Failed to edit control panel (vc=${record.voiceChannelId}):`, editErr)
      return
    }
  }

  const msg = await textChannel.send(payload as any).catch(err => {
    logger.warn(`Failed to post control panel (vc=${record.voiceChannelId}):`, err)
    return null
  })
  if (!msg) return

  await db.update(autoChannels)
    .set({ controlPanelMsgId: msg.id })
    .where(eq(autoChannels.voiceChannelId, record.voiceChannelId))
    .catch(err => logger.warn(`Failed to persist control_panel_msg_id (vc=${record.voiceChannelId}):`, err))
}

/** Re-export so VoiceBasedChannel is accessible to callers wiring up the prefetch path. */
export type { VoiceBasedChannel }
