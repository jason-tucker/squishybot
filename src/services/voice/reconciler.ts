import type { Client } from 'discord.js'
import { ChannelType } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels, hubChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { scheduleCleanup, restoreScheduledCleanups } from './cleanupScheduler'
import { postOrUpdateControlPanel } from './controlPanel'
import { postOrUpdateSticky } from './sticky'
import { syncTextChannelPermissions } from './permissions'
import { seedHubsFromEnv } from './hubManager'
import { createAutoChannel } from './autoChannel'
import { logger } from '../logger'
import { unregisterHubChannel, updateHubChannelId } from '../settings'

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
  const records = await db.select().from(autoChannels).where(eq(autoChannels.guildId, guild.id))
  const trackedVoiceIds = new Set(records.map(r => r.voiceChannelId))

  for (const record of records) {
    const vc = await guild.channels.fetch(record.voiceChannelId).catch(() => null)

    if (!vc) {
      // Voice channel gone — clean up text channel and DB row
      await guild.channels.delete(record.textChannelId).catch(() => {})
      await db.delete(autoChannels).where(eq(autoChannels.voiceChannelId, record.voiceChannelId)).catch(() => {})
      result.cleaned++
      logger.info(`Reconciler: cleaned orphan vc=${record.voiceChannelId}`)
      continue
    }

    result.recovered++

    // Schedule cleanup if empty
    if (vc.isVoiceBased() && vc.members.size === 0) {
      scheduleCleanup(client, record.voiceChannelId)
    }

    // Sync text channel permissions for current members
    const tc = await guild.channels.fetch(record.textChannelId).catch(() => null)
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
        for (const [, m] of stale) {
          await m.delete().catch(() => {})
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
        }
      }

      // Always re-post the sticky on startup so it's at the bottom and current
      await postOrUpdateSticky(client, record)
    }
  }

  // --- Scan category for occupied channels not in the DB ---
  // Handles the case where the bot was offline when a user joined a hub.
  // The hub gets renamed but no DB record was created. On startup we adopt it.
  const hubs = await db.select().from(hubChannels).where(eq(hubChannels.guildId, guild.id))
  const hubIds = new Set(hubs.map(h => h.channelId))

  const category = await guild.channels.fetch(env.AUTO_VOICE_CATEGORY_ID).catch(() => null)
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
        await db.update(hubChannels).set({ channelId: newHub.id }).where(eq(hubChannels.id, hub.id))
        updateHubChannelId(hub.channelId, newHub.id)
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
