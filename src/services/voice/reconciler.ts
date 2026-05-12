import type { Client } from 'discord.js'
import { ChannelType } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels, hubChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { scheduleCleanup, restoreScheduledCleanups } from './cleanupScheduler'
import { restoreOwnerGraces } from './ownerGrace'
import { restoreHubLockdowns } from './hubLockdown'
import { postOrUpdateControlPanel } from './controlPanel'
import { postOrUpdateSticky } from './sticky'
import { syncTextChannelPermissions } from './permissions'
import { seedHubsFromEnv } from './hubManager'
import { createAutoChannel } from './autoChannel'
import { computeAutoName } from './autoNaming'
import { backfillMembers, clearMembers } from './voiceMembers'
import { logger } from '../logger'
import { getSetting, unregisterHubChannel, untrackAutoChannelText, untrackAutoChannelVoice, updateHubChannelId } from '../settings'

export interface ReconcilerResult {
  recovered: number
  cleaned: number
  hubs: number
  panels: number
  adopted: number
}

export async function runReconciler(client: Client): Promise<ReconcilerResult> {
  // Fetch guild via API rather than cache — ensures it's available even on first boot
  const guild = client.guilds.cache.get(env.GUILD_ID)
    ?? await client.guilds.fetch(env.GUILD_ID).catch(() => null)

  if (!guild) {
    logger.error('Reconciler: guild not found')
    return { recovered: 0, cleaned: 0, hubs: 0, panels: 0, adopted: 0 }
  }

  const result: ReconcilerResult = { recovered: 0, cleaned: 0, hubs: 0, panels: 0, adopted: 0 }

  // Ensure hubs from env are registered
  await seedHubsFromEnv(guild)

  // --- Reconcile known auto channels from DB ---
  // Process records in chunks: each record's inner work serializes (fetch
  // → permissions sync → message sweep → sticky), but records don't depend
  // on each other. Bound the parallelism so a server with N rooms doesn't
  // fan out into N parallel REST request streams (Discord's global REST
  // bucket would shed load and add per-record latency anyway).
  const RECONCILE_CONCURRENCY = 5
  const records = await db.select().from(autoChannels).where(eq(autoChannels.guildId, guild.id))
  const trackedVoiceIds = new Set(records.map(r => r.voiceChannelId))

  const reconcileOne = async (record: typeof records[number]) => {
    // Cache.get is free; the bot manages these channels so they're cached
    // once READY fires. Falls back to fetch only if the cache is cold (e.g.
    // first reconcile pass before the guild fully populates).
    const vc = guild.channels.cache.get(record.voiceChannelId)
      ?? await guild.channels.fetch(record.voiceChannelId).catch(() => null)

    if (!vc) {
      // Voice channel gone — clean up text channel and DB row
      await guild.channels.delete(record.textChannelId).catch(() => {})
      await db.delete(autoChannels).where(eq(autoChannels.voiceChannelId, record.voiceChannelId)).catch(() => {})
      await clearMembers(record.voiceChannelId)
      untrackAutoChannelText(record.textChannelId)
      untrackAutoChannelVoice(record.voiceChannelId)
      result.cleaned++
      logger.info(`Reconciler: cleaned orphan vc=${record.voiceChannelId}`)
      return
    }

    result.recovered++

    // Schedule cleanup if empty
    if (vc.isVoiceBased() && vc.members.size === 0) {
      scheduleCleanup(client, record.voiceChannelId)
    }

    // Backfill member join times for anyone currently in the channel that we
    // didn't yet have a row for. One bulk INSERT instead of N parallel calls.
    if (vc.isVoiceBased()) {
      await backfillMembers(record.voiceChannelId, vc.members.map(m => m.id))
    }

    // Hoist the text-channel fetch — both the auto-rename retry below AND
    // the permission sync need it. Cache first to skip the HTTP round-trip.
    const tc = guild.channels.cache.get(record.textChannelId)
      ?? await guild.channels.fetch(record.textChannelId).catch(() => null)

    // Retroactively auto-rename when the channel is opted into auto-naming
    // and any current member is playing something. Covers the gap where
    // presenceUpdate events between bot restarts were lost.
    if (vc.isVoiceBased() && record.autoNameEnabled
        && (record.nameTemplate === null || record.nameTemplate === 'auto' || record.nameTemplate === 'counter')) {
      const computed = computeAutoName(vc, record.ownerUserId, record.nameTemplate, record.userLimit)
      const newName = computed ?? record.fallbackName
      if (newName && vc.name !== newName) {
        await vc.setName(newName).catch(() => {})
        const textName = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice-chat'
        if (tc?.isTextBased()) await (tc as any).setName(textName).catch(() => {})
        logger.info(`Reconciler auto-rename: vc=${record.voiceChannelId} → ${newName}`)
      }
    }

    // Sync text channel permissions for current members
    if (tc?.isTextBased() && vc.isVoiceBased()) {
      await syncTextChannelPermissions(tc as any, vc as any, record, client.user!.id).catch(() => {})
    }

    // Re-post control panel + sticky if missing. Sweep any leftover bot messages
    // (not the tracked panel or sticky) so duplicates don't accumulate.
    if (tc?.isTextBased()) {
      const recent = await (tc as any).messages.fetch({ limit: 30 }).catch(() => null)
      if (recent) {
        const stale = recent.filter((m: any) =>
          m.author?.id === client.user!.id
          && m.id !== record.controlPanelMsgId
          && m.id !== record.stickyMsgId
        )
        // Delete sequentially: parallel-deleting up to 30 messages × N
        // records was easily a hundred concurrent DELETE calls and tripped
        // Discord's global REST bucket on busy boots.
        for (const m of stale.values()) {
          await (m as any).delete().catch(() => {})
        }
      }

      if (!record.controlPanelMsgId) {
        await postOrUpdateControlPanel(client, record)
        result.panels++
      } else {
        const existing = await (tc as any).messages.fetch(record.controlPanelMsgId).catch(() => null)
        if (!existing) {
          await db.update(autoChannels).set({ controlPanelMsgId: null }).where(eq(autoChannels.voiceChannelId, record.voiceChannelId))
          await postOrUpdateControlPanel(client, { ...record, controlPanelMsgId: null })
          result.panels++
        } else {
          // Refresh content in place so format/layout changes from deploys
          // (and current member list / live timestamps) take effect immediately.
          await postOrUpdateControlPanel(client, record)
        }
      }

      // Always re-post the sticky on startup so it's at the bottom and current
      await postOrUpdateSticky(client, record)
    }
  }

  for (let i = 0; i < records.length; i += RECONCILE_CONCURRENCY) {
    const slice = records.slice(i, i + RECONCILE_CONCURRENCY)
    await Promise.all(slice.map(reconcileOne))
  }

  // --- Scan category for occupied channels not in the DB ---
  // Handles the case where the bot was offline when a user joined a hub.
  // The hub gets renamed but no DB record was created. On startup we adopt it.
  const hubs = await db.select().from(hubChannels).where(eq(hubChannels.guildId, guild.id))
  const hubIds = new Set(hubs.map(h => h.channelId))

  const categoryId = getSetting('channel.auto_voice_category') ?? env.AUTO_VOICE_CATEGORY_ID
  const category = await guild.channels.fetch(categoryId).catch(() => null)
  if (category?.type === ChannelType.GuildCategory) {
    for (const [, channel] of (category as any).children.cache) {
      if (channel.type !== ChannelType.GuildVoice) continue
      if (hubIds.has(channel.id)) continue          // skip hubs
      if (trackedVoiceIds.has(channel.id)) continue // already tracked
      if (channel.members.size === 0) continue      // empty — skip, cleanup will handle

      // Untracked occupied voice channel — adopt it as an auto channel
      const owner = channel.members.first()!
      logger.info(`Reconciler: adopting untracked vc=${channel.id} (${channel.name}), owner=${owner.displayName}`)

      const record = await createAutoChannel(client, guild, owner, channel, 'recovered', channel.name)
      if (record) result.adopted++
    }
  }

  // Restore in-progress cleanup timers from DB
  await restoreScheduledCleanups(client)
  // Restore in-progress owner-grace timers from DB (promotes any overdue)
  await restoreOwnerGraces(client)
  // Restore hub lockdowns from DB (re-apply Connect denials and schedule unlocks)
  await restoreHubLockdowns(client)

  // --- Reconcile hubs ---
  for (const hub of hubs) {
    const vc = await guild.channels.fetch(hub.channelId).catch(() => null)
    if (!vc) {
      // Don't recreate if a channel with the same label already exists in the
      // category — that means this hub row is stale/corrupt and recreating
      // would just spawn a duplicate next to a user's existing channel.
      const cat = await guild.channels.fetch(hub.categoryId).catch(() => null)
      const existing = cat?.type === ChannelType.GuildCategory
        ? (cat as any).children.cache.find((c: any) =>
            c.type === ChannelType.GuildVoice && c.name === hub.label)
        : null

      if (existing) {
        logger.warn(`Reconciler: hub ${hub.id} stale; channel "${hub.label}" already exists as ${existing.id} — removing hub row`)
        await unregisterHubChannel(hub.channelId).catch(() => {})
        continue
      }

      try {
        const newHub = await guild.channels.create({
          name: hub.label,
          type: ChannelType.GuildVoice,
          parent: hub.categoryId,
          position: hub.position,
        })
        // Cache before DB so a join on the new hub is recognized immediately.
        updateHubChannelId(hub.channelId, newHub.id)
        await db.update(hubChannels).set({ channelId: newHub.id }).where(eq(hubChannels.id, hub.id))
        result.hubs++
        logger.info(`Reconciler: recreated hub ${hub.label} (${newHub.id})`)
      } catch (err) {
        logger.error(`Reconciler: failed to recreate hub ${hub.id}:`, err)
      }
    } else {
      result.hubs++
    }
  }

  logger.info(`Reconciler: recovered=${result.recovered} cleaned=${result.cleaned} hubs=${result.hubs} panels=${result.panels} adopted=${result.adopted}`)
  return result
}
