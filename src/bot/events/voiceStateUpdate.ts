import type { Client, VoiceState } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { isHubChannel, handleHubJoin } from '../../services/voice/hubManager'
import { addMemberToTextChannel, isSudo, removeMemberFromTextChannel } from '../../services/voice/permissions'
import { scheduleCleanup, cancelCleanup } from '../../services/voice/cleanupScheduler'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'
import { cancelHideGrace, grantHideGrace } from '../../services/voice/hideGrace'
import { cancelGraceTimer, getOwnerGraceMs, pickActingOwner, scheduleGracePromotion } from '../../services/voice/ownerGrace'
import { recordMemberJoin, recordMemberLeave } from '../../services/voice/voiceMembers'
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
        // Cache.get is free vs fetch's HTTP round-trip; the channel will be
        // in cache because the bot manages it. Fall back to fetch only on miss.
        const textChannel = guild.channels.cache.get(record.textChannelId)
          ?? await guild.channels.fetch(record.textChannelId).catch(() => null)
        if (textChannel?.isTextBased()) {
          await addMemberToTextChannel(textChannel as any, member)
        }
        await recordMemberJoin(joinedChannelId, member.id)

        // Owner returned during their grace window — restore them, drop the
        // acting owner, refresh the panel.
        let updatedRecord = record
        if (record.actingOwnerUserId && record.ownerUserId === member.id) {
          cancelGraceTimer(joinedChannelId)
          await db.update(autoChannels)
            .set({ actingOwnerUserId: null, ownerGraceExpiresAt: null, lastActiveAt: new Date() })
            .where(eq(autoChannels.voiceChannelId, joinedChannelId))
            .catch(() => {})
          updatedRecord = { ...record, actingOwnerUserId: null, ownerGraceExpiresAt: null }
          logger.info(`Owner ${member.id} returned within grace — restored in vc=${joinedChannelId}`)
        } else {
          await db.update(autoChannels)
            .set({ lastActiveAt: new Date() })
            .where(eq(autoChannels.voiceChannelId, joinedChannelId))
            .catch(() => {})
        }
        await postOrUpdateControlPanel(client, updatedRecord).catch(() => {})
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

      await recordMemberLeave(leftChannelId, member.id)

      // Owner, hosts, and the current acting owner keep their text-channel
      // overwrite when they leave the VC. Acting owner needs to retain access
      // for the duration of the grace so they can still see/operate the panel.
      const isSpecialUser =
        record.ownerUserId === member.id
        || record.hostUserIds.includes(member.id)
        || record.actingOwnerUserId === member.id
      if (!isSpecialUser) {
        const textChannel = guild.channels.cache.get(record.textChannelId)
          ?? await guild.channels.fetch(record.textChannelId).catch(() => null)
        if (textChannel?.isTextBased()) {
          await removeMemberFromTextChannel(textChannel as any, member)
        }
      }

      const vc = guild.channels.cache.get(leftChannelId)
        ?? await guild.channels.fetch(leftChannelId).catch(() => null)
      if (!vc?.isVoiceBased()) return

      // Hide-grace: when leaving a hidden VC, non-sudo regular members lose
      // visibility. Give them 90s to rejoin (e.g. after a network blip).
      // Owner/hosts/sudo already hold permanent ViewChannel allows from the
      // hide flow, so they don't need this.
      if (record.isHidden && !isSpecialUser && !isSudo(member)) {
        await grantHideGrace(vc, member.id)
      }

      let updatedRecord = record
      const remainingMemberIds = new Set(vc.members.map(m => m.id))

      if (record.ownerUserId === member.id && remainingMemberIds.size > 0) {
        // OWNER LEFT — try to enter a grace window.
        const graceMs = getOwnerGraceMs()
        const actingOwner = graceMs > 0 ? await pickActingOwner(record, remainingMemberIds) : null

        if (actingOwner) {
          const expiresAt = new Date(Date.now() + graceMs)
          await db.update(autoChannels)
            .set({ actingOwnerUserId: actingOwner, ownerGraceExpiresAt: expiresAt })
            .where(eq(autoChannels.voiceChannelId, leftChannelId))
            .catch(() => {})
          scheduleGracePromotion(client, leftChannelId, expiresAt)
          updatedRecord = { ...record, actingOwnerUserId: actingOwner, ownerGraceExpiresAt: expiresAt }
          logger.info(`Owner ${member.id} stepped out — acting owner ${actingOwner} in vc=${leftChannelId} for ${graceMs}ms`)
        } else {
          // Grace disabled or nobody eligible — fall back to instant transfer.
          const newOwner = vc.members.first()!
          const newOwnerHosts = record.hostUserIds.filter(id => id !== newOwner.id)
          await db.update(autoChannels)
            .set({ ownerUserId: newOwner.id, hostUserIds: newOwnerHosts, actingOwnerUserId: null, ownerGraceExpiresAt: null })
            .where(eq(autoChannels.voiceChannelId, leftChannelId))
            .catch(() => {})
          logger.info(`Ownership transferred to ${newOwner.displayName} in vc=${leftChannelId}`)
          updatedRecord = { ...record, ownerUserId: newOwner.id, hostUserIds: newOwnerHosts, actingOwnerUserId: null, ownerGraceExpiresAt: null }
        }
      } else if (record.actingOwnerUserId === member.id && remainingMemberIds.size > 0) {
        // ACTING OWNER LEFT during grace — per design, this breaks the chain:
        // the original owner forfeits their reclaim, and the next person
        // present becomes the permanent owner. Reusing the instant-transfer
        // path with vc.members.first() — pickActingOwner's host-first heuristic
        // doesn't apply here because the previous acting owner already failed
        // to hold the seat.
        cancelGraceTimer(leftChannelId)
        const newOwner = vc.members.first()!
        const newOwnerHosts = record.hostUserIds.filter(id => id !== newOwner.id)
        await db.update(autoChannels)
          .set({ ownerUserId: newOwner.id, hostUserIds: newOwnerHosts, actingOwnerUserId: null, ownerGraceExpiresAt: null })
          .where(eq(autoChannels.voiceChannelId, leftChannelId))
          .catch(() => {})
        logger.info(`Acting owner ${member.id} left — grace cancelled, ownership permanently transferred to ${newOwner.displayName} in vc=${leftChannelId}`)
        updatedRecord = { ...record, ownerUserId: newOwner.id, hostUserIds: newOwnerHosts, actingOwnerUserId: null, ownerGraceExpiresAt: null }
      }

      // Schedule cleanup if channel is now empty; otherwise refresh the panel
      // (member list and possibly new owner). Skipped for the empty case — the
      // channel is about to be cleaned up.
      if (vc.members.size === 0) {
        // Empty room — any pending grace is moot; cleanup will delete both
        // channels. cancelGraceTimer is idempotent.
        cancelGraceTimer(leftChannelId)
        scheduleCleanup(client, leftChannelId)
      } else {
        await postOrUpdateControlPanel(client, updatedRecord).catch(() => {})
      }
    }
  })
}
