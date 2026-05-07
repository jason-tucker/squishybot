import type { Client, VoiceState } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { isHubChannel, handleHubJoin } from '../../services/voice/hubManager'
import { addMemberToTextChannel, isSudo, removeMemberFromTextChannel } from '../../services/voice/permissions'
import { scheduleCleanup, cancelCleanup } from '../../services/voice/cleanupScheduler'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'
import { cancelHideGrace, grantHideGrace } from '../../services/voice/hideGrace'
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
      // Check auto_channels FIRST. The hub-cache eviction lags the hub→auto
      // rename by a couple of awaits (it lives in createReplacementHub which
      // runs after createAutoChannel returns). Anyone joining the same channel
      // ID during that window — typically the second of two near-simultaneous
      // joiners — would otherwise be misclassified as a hub join, hit the
      // unique constraint on auto_channels.voice_channel_id, and crash. By
      // checking auto_channels first we route them straight into the joined
      // user's room as a normal join.
      const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, joinedChannelId))
      if (record) {
        cancelCleanup(joinedChannelId)
        // They're back inside the VC — they have inherent view, no need to keep
        // a pending grace timer running.
        cancelHideGrace(joinedChannelId, member.id)
        const textChannel = await guild.channels.fetch(record.textChannelId).catch(() => null)
        if (textChannel?.isTextBased()) {
          await addMemberToTextChannel(textChannel as any, member)
        }
        await db.update(autoChannels)
          .set({ lastActiveAt: new Date() })
          .where(eq(autoChannels.voiceChannelId, joinedChannelId))
          .catch(() => {})
        return
      }

      // Otherwise — actual hub join.
      if (isHubChannel(joinedChannelId)) {
        await handleHubJoin(client, guild, member, joinedChannelId)
        return
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

      // Hide-grace: when leaving a hidden VC, non-sudo regular members lose
      // visibility. Give them 90s to rejoin (e.g. after a network blip).
      // Owner/hosts/sudo already hold permanent ViewChannel allows from the
      // hide flow, so they don't need this.
      if (record.isHidden && !isSpecialUser && !isSudo(member)) {
        await grantHideGrace(vc, member.id)
      }

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
