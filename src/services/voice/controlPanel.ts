import type { Client, TextChannel } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { buildControlPanelPayload } from '../../embeds/voiceControlPanel'
import type { AutoChannelRecord } from '../../types/voice'
import { logger } from '../logger'

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

export async function postOrUpdateControlPanel(client: Client, record: AutoChannelRecord): Promise<void> {
  const guild = client.guilds.cache.first()
  if (!guild) return

  const textChannel = await guild.channels.fetch(record.textChannelId).catch(() => null) as TextChannel | null
  if (!textChannel?.isTextBased()) return

  const { ownerTag, hostTags } = await resolveDisplayTags(client, record)
  const payload = buildControlPanelPayload(record, ownerTag, hostTags)

  // Try to edit existing panel message
  if (record.controlPanelMsgId) {
    const existing = await textChannel.messages.fetch(record.controlPanelMsgId).catch(() => null)
    if (existing) {
      const editErr = await existing.edit({ ...payload, content: null } as any).then(() => null).catch(err => err)
      if (editErr) logger.error(`Failed to edit control panel (vc=${record.voiceChannelId}):`, editErr)
      return
    }
  }

  // Post a new panel message — omit content entirely (null is invalid for channel.send)
  const msg = await textChannel.send(payload as any).catch(err => {
    logger.warn('Failed to post control panel:', err)
    return null
  })
  if (!msg) return

  await db.update(autoChannels)
    .set({ controlPanelMsgId: msg.id })
    .where(eq(autoChannels.voiceChannelId, record.voiceChannelId))
    .catch(() => {})
}
