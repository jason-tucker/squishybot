import type { Client, Guild, GuildMember, VoiceState } from 'discord.js'
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
import { recordVoiceActivity } from '../../services/activity/tracker'
import { noteVoiceStateForOverflow } from '../../services/voice/overflowGate'
import { createKeyedQueue, membersAfterLeave, planTransition, queueVoiceUpdate, type VoiceStateSnapshot } from '../../services/voice/lifecycle'

// One member's voice events are handled strictly in order: discord.js runs
// async listeners concurrently, and a fast A -> B -> leave sequence must not
// let the later leave of B finish before the earlier join of B.
const memberQueue = createKeyedQueue()

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
      recordVoiceActivity(oldState, newState)
      // Overflow gate: must run before handleVoiceStateUpdate's bot filter and
      // unmanaged-leave early return (watched VCs are usually unmanaged and
      // bots count toward "full").
      noteVoiceStateForOverflow(oldState, newState)
      // VoiceState.id is the member's user id. Both states are snapshotted
      // now, before queuing: newState is discord.js's cached VoiceState and is
      // patched in place by the member's next update, so a queued handler
      // reading it later could see a later channel.
      await queueVoiceUpdate(memberQueue, oldState, newState, (oldSnap, newSnap) =>
        handleVoiceStateUpdate(client, oldSnap, newSnap))
    } catch (err) {
      logger.error('voiceStateUpdate handler threw — swallowed', err)
    }
  })
}

type VoiceSnapshot = VoiceStateSnapshot<Guild, GuildMember>

async function handleVoiceStateUpdate(client: Client, oldState: VoiceSnapshot, newState: VoiceSnapshot): Promise<void> {
    // Only handle the configured guild
    if (newState.guild.id !== env.GUILD_ID && oldState.guild.id !== env.GUILD_ID) return

    const member = newState.member ?? oldState.member
    if (!member || member.user.bot) return

    recordActivity()

    const guild = newState.guild.id === env.GUILD_ID ? newState.guild : oldState.guild
    const leftChannelId = oldState.channelId
    const joinedChannelId = newState.channelId

    // A move is a leave of the old channel AND a join of the new one. Run the
    // leave half first and each half in its own try/catch: the join half
    // returns early for managed rooms, static VCs and hubs, and must never
    // skip the old room's text-access removal, owner grace or empty cleanup.
    for (const step of planTransition(leftChannelId, joinedChannelId)) {
      try {
        if (step.kind === 'leave') await handleLeave(client, guild, member, step.channelId)
        else await handleJoin(client, guild, member, step.channelId)
      } catch (err) {
        logger.error(`voiceStateUpdate ${step.kind} half threw for vc=${step.channelId} — swallowed`, err)
      }
    }
}

// --- JOINED A CHANNEL ---
async function handleJoin(client: Client, guild: Guild, member: GuildMember, joinedChannelId: string): Promise<void> {
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
async function handleLeave(client: Client, guild: Guild, member: GuildMember, leftChannelId: string): Promise<void> {
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
      // This leave may run late from the member queue, after the member has
      // already rejoined; the live member list then still contains them.
      // Never count the leaver as remaining, and if they are back in the room
      // skip the ownership change: they are present, and the queued rejoin
      // that follows refreshes the panel.
      const { leaverStillPresent, remaining } = membersAfterLeave(vc.members.keys(), member.id)
      const remainingMemberIds = new Set(remaining)

      if (leaverStillPresent) {
        logger.info(`Leave of ${member.id} from vc=${leftChannelId} ran after they rejoined — ownership left unchanged`)
      } else if (record.ownerUserId === member.id && remainingMemberIds.size > 0) {
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
          const newOwner = vc.members.get(remaining[0]!)!
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
        // path with the first remaining member — pickActingOwner's host-first heuristic
        // doesn't apply here because the previous acting owner already failed
        // to hold the seat.
        cancelGraceTimer(leftChannelId)
        const newOwner = vc.members.get(remaining[0]!)!
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
        void scheduleCleanup(client, leftChannelId).catch(err => logger.warn(`scheduleCleanup failed for vc=${leftChannelId}`, err))
      } else {
        await postOrUpdateControlPanel(client, updatedRecord).catch(() => {})
        // Member who left may have been the one whose game was driving the
        // channel name — re-evaluate so the fallback kicks in.
        await maybeRenameChannel(client, updatedRecord).catch(() => {})
      }
}
