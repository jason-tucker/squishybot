import type { Client, VoiceState } from 'discord.js'
import { ActivityType } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { isHubChannel, handleHubJoin } from '../../services/voice/hubManager'
import { addMemberToTextChannel, isSudo, removeMemberFromTextChannel } from '../../services/voice/permissions'
import { scheduleCleanup, cancelCleanup } from '../../services/voice/cleanupScheduler'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'
import { cancelHideGrace, grantHideGrace } from '../../services/voice/hideGrace'
import { cancelGraceTimer, getOwnerGraceMs, pickActingOwner, scheduleGracePromotion } from '../../services/voice/ownerGrace'
import { maybeRenameChannel } from '../../services/voice/autoRename'
import { recordMemberJoin, recordMemberLeave } from '../../services/voice/voiceMembers'
import { logChannelEvent } from '../../services/voice/channelLog'
import { isAutoChannelVoice } from '../../services/settings'
import { logger } from '../../services/logger'
import { recordActivity } from '../../services/presence'
import { env } from '../../config/env'
import { publish, voiceCh, type VoiceOwnerChangedEvent } from '../../services/eventBus'
import { isStaticChannel } from '../../services/voice/staticChannels'
import { createStaticChannelText } from '../../services/voice/autoChannel'

export function registerVoiceStateUpdate(client: Client): void {
  client.on('voiceStateUpdate', async (oldState: VoiceState, newState: VoiceState) => {
    // Catch ANY error in this handler so a transient DB blip (e.g. a pool
    // connection failing SCRAM mid-burst) doesn't surface as an
    // uncaughtException. The user-visible effect of a swallowed error is
    // "I joined a channel but nothing happened" — same as if Discord had
    // dropped the gateway event. We retry naturally on the user's next
    // state change. Discord.js's listener executes async handlers via
    // Promise.then with no error boundary; without this wrap a rejected
    // promise crashes the worker.
    try {
      await handleVoiceStateUpdate(client, oldState, newState)
    } catch (err) {
      logger.error('voiceStateUpdate handler threw — swallowed', err)
    }
  })
}

async function handleVoiceStateUpdate(client: Client, oldState: VoiceState, newState: VoiceState): Promise<void> {
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
      // Check the auto-channel cache FIRST (before the hub check). The
      // hub-cache eviction lags the hub→auto rename by a couple of awaits
      // (it lives in createReplacementHub which runs after createAutoChannel
      // returns), so during that window a channel can be both "still a hub"
      // and "already an auto channel" — the second of two near-simultaneous
      // joiners must be routed into the joined user's room as a normal join,
      // not re-processed as a hub join. (handleHubJoin also re-checks
      // auto_channels itself, so the residual sub-await window where the DB
      // row exists but the cache isn't tracked yet is covered too.)
      //
      // Gating the DB read on the in-memory cache means joins to unmanaged
      // voice channels — the common case guild-wide — skip Postgres entirely,
      // mirroring the presenceUpdate hot-path short-circuit. The cache is
      // populated by loadSettings() at boot and kept in lockstep by the
      // create/delete lifecycle hooks in autoChannel.ts.
      const [record] = isAutoChannelVoice(joinedChannelId)
        ? await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, joinedChannelId))
        : []
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
        await recordMemberJoin(joinedChannelId, member.id, guild.id)
        logChannelEvent({ voiceChannelId: joinedChannelId, guildId: guild.id, type: 'join', actorUserId: member.id })
        // If they walked in already playing something, record it — presenceUpdate
        // won't fire on a voice join, so otherwise a resulting Smart auto-rename
        // would look unexplained in the log.
        const joinGame = member.presence?.activities.find(a => a.type === ActivityType.Playing)?.name ?? null
        if (joinGame) logChannelEvent({ voiceChannelId: joinedChannelId, guildId: guild.id, type: 'game_start', actorUserId: member.id, detail: joinGame })

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
        // New member arrived — they may be playing something that should
        // change the channel name. Re-evaluate (handles throttle internally).
        await maybeRenameChannel(client, updatedRecord).catch(() => {})
        return
      }

      // Static-channel join: if the joined channel is a static VC and it has no
      // active companion text channel yet, create one now. If the static record
      // already exists we fall through to the "joined an existing auto channel"
      // block above (which already handled it via the isAutoChannelVoice check).
      // A static VC that is also (mis)configured as a hub gets static treatment
      // first — the check runs before isHubChannel.
      if (isStaticChannel(joinedChannelId) && !isAutoChannelVoice(joinedChannelId)) {
        const vc = guild.channels.cache.get(joinedChannelId)
          ?? await guild.channels.fetch(joinedChannelId).catch(() => null)
        if (vc?.isVoiceBased()) {
          const staticRecord = await createStaticChannelText(client, guild, member, vc as any).catch(err => {
            logger.warn('Failed to create static channel text:', err)
            return null
          })
          // Same insta-leave race as the hub path: if the joiner left before the
          // companion text channel's record hit the cache, the LEAVE branch
          // above bailed on its `isAutoChannelVoice` gate and never scheduled
          // cleanup of the orphaned text channel. Re-check occupancy now and
          // schedule cleanup (deleteStaticText keeps the VC, drops the text
          // channel). Idempotent with the LEAVE branch.
          if (staticRecord && vc.members.size === 0) {
            logger.info(`Static channel vc=${joinedChannelId} is empty right after companion-text creation (joiner left immediately) — scheduling cleanup`)
            await scheduleCleanup(client, joinedChannelId)
          }
        }
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
      // Same hot-path gate as the join branch: leaves from unmanaged voice
      // channels skip the DB read entirely.
      if (!isAutoChannelVoice(leftChannelId)) return
      const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, leftChannelId))
      if (!record) return

      await recordMemberLeave(leftChannelId, member.id, guild.id)
      logChannelEvent({ voiceChannelId: leftChannelId, guildId: guild.id, type: 'leave', actorUserId: member.id })

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
          logChannelEvent({ voiceChannelId: leftChannelId, guildId: guild.id, type: 'owner_transfer', actorUserId: newOwner.id })
          void publish<VoiceOwnerChangedEvent>(voiceCh('owner_changed'), {
            voiceChannelId: leftChannelId,
            oldOwnerUserId: record.ownerUserId,
            newOwnerUserId: newOwner.id,
            ts: new Date().toISOString(),
          })
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
        logChannelEvent({ voiceChannelId: leftChannelId, guildId: guild.id, type: 'owner_transfer', actorUserId: newOwner.id })
        void publish<VoiceOwnerChangedEvent>(voiceCh('owner_changed'), {
          voiceChannelId: leftChannelId,
          oldOwnerUserId: record.ownerUserId,
          newOwnerUserId: newOwner.id,
          ts: new Date().toISOString(),
        })
      }

      // Schedule cleanup if channel is now empty; otherwise refresh the panel
      // (member list and possibly new owner). Skipped for the empty case — the
      // channel is about to be cleaned up.
      if (vc.members.size === 0) {
        // Empty room — any pending grace is moot; cleanup will delete both
        // channels. cancelGraceTimer is idempotent.
        cancelGraceTimer(leftChannelId)
        void scheduleCleanup(client, leftChannelId)
      } else {
        await postOrUpdateControlPanel(client, updatedRecord).catch(() => {})
        // Member who left may have been the one whose game was driving the
        // channel name — re-evaluate so the fallback kicks in.
        await maybeRenameChannel(client, updatedRecord).catch(() => {})
      }
    }
}
