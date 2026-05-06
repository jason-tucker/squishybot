import type { Client, VoiceState } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { isHubChannel, handleHubJoin } from '../../services/voice/hubManager'
import { addMemberToTextChannel, removeMemberFromTextChannel } from '../../services/voice/permissions'
import { scheduleCleanup, cancelCleanup } from '../../services/voice/cleanupScheduler'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'
import { logger } from '../../services/logger'
import { recordActivity } from '../../services/presence'
import { env } from '../../config/env'

export function registerVoiceStateUpdate(client: Client): void {
  client.on('voiceStateUpdate', async (oldState: VoiceState, newState: VoiceState) => {
    // Only handle the configured guild
    if (newState.guild.id !== env.GUILD_ID && oldState.guild.id !== env.GUILD_ID) return

    const member = newState.member ?? oldState.member
    if (!member || member.user.bot) return

    recordActivity()

    const guild = newState.guild.id === env.GUILD_ID ? newState.guild : oldState.guild
    const leftChannelId = oldState.channelId
    const joinedChannelId = newState.channelId

    // --- JOINED A CHANNEL ---
    if (joinedChannelId && joinedChannelId !== leftChannelId) {
      // Check if it's a hub
      if (isHubChannel(joinedChannelId)) {
        await handleHubJoin(client, guild, member, joinedChannelId)
        return
      }

      // Check if it's an existing auto channel
      const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, joinedChannelId))
      if (record) {
        cancelCleanup(joinedChannelId)
        const textChannel = await guild.channels.fetch(record.textChannelId).catch(() => null)
        if (textChannel?.isTextBased()) {
          await addMemberToTextChannel(textChannel as any, member)
        }
        await db.update(autoChannels)
          .set({ lastActiveAt: new Date() })
          .where(eq(autoChannels.voiceChannelId, joinedChannelId))
          .catch(() => {})
      }
    }

    // --- LEFT A CHANNEL ---
    if (leftChannelId && leftChannelId !== joinedChannelId) {
      const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, leftChannelId))
      if (!record) return

      // Remove from text channel (only if they're not a host/owner with permanent access)
      const isSpecialUser = record.ownerUserId === member.id || record.hostUserIds.includes(member.id)
      if (!isSpecialUser) {
        const textChannel = await guild.channels.fetch(record.textChannelId).catch(() => null)
        if (textChannel?.isTextBased()) {
          await removeMemberFromTextChannel(textChannel as any, member)
        }
      }

      const vc = await guild.channels.fetch(leftChannelId).catch(() => null)
      if (!vc?.isVoiceBased()) return

      // Handle ownership transfer if owner left
      if (record.ownerUserId === member.id && vc.members.size > 0) {
        const newOwner = vc.members.first()!
        const newOwnerHosts = record.hostUserIds.filter(id => id !== newOwner.id)
        await db.update(autoChannels)
          .set({ ownerUserId: newOwner.id, hostUserIds: newOwnerHosts })
          .where(eq(autoChannels.voiceChannelId, leftChannelId))
          .catch(() => {})
        logger.info(`Ownership transferred to ${newOwner.displayName} in vc=${leftChannelId}`)
        const updatedRecord = { ...record, ownerUserId: newOwner.id, hostUserIds: newOwnerHosts }
        await postOrUpdateControlPanel(client, updatedRecord).catch(() => {})
      }

      // Schedule cleanup if channel is now empty
      if (vc.members.size === 0) {
        scheduleCleanup(client, leftChannelId)
      }
    }
  })
}
