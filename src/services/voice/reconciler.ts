import type { Client } from 'discord.js'
import { ChannelType } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels, hubChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { scheduleCleanup, restoreScheduledCleanups } from './cleanupScheduler'
import { postOrUpdateControlPanel } from './controlPanel'
import { syncTextChannelPermissions } from './permissions'
import { seedHubsFromEnv } from './hubManager'
import { logger } from '../logger'

export interface ReconcilerResult {
  recovered: number
  cleaned: number
  hubs: number
  panels: number
}

export async function runReconciler(client: Client): Promise<ReconcilerResult> {
  const guild = client.guilds.cache.get(env.GUILD_ID)
  if (!guild) {
    logger.error('Reconciler: guild not found')
    return { recovered: 0, cleaned: 0, hubs: 0, panels: 0 }
  }

  const result: ReconcilerResult = { recovered: 0, cleaned: 0, hubs: 0, panels: 0 }

  // Ensure hubs from env are registered
  await seedHubsFromEnv(guild)

  // --- Reconcile auto channels ---
  const records = await db.select().from(autoChannels).where(eq(autoChannels.guildId, guild.id))

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

    // Restore cleanup timers
    if (vc.isVoiceBased() && vc.members.size === 0) {
      scheduleCleanup(client, record.voiceChannelId)
    }

    // Sync text channel permissions
    const tc = await guild.channels.fetch(record.textChannelId).catch(() => null)
    if (tc?.isTextBased() && vc.isVoiceBased()) {
      await syncTextChannelPermissions(tc as any, vc as any, record, client.user!.id).catch(() => {})
    }

    // Re-post control panel if missing
    if (!record.controlPanelMsgId && tc?.isTextBased()) {
      await postOrUpdateControlPanel(client, record)
      result.panels++
    } else if (record.controlPanelMsgId && tc?.isTextBased()) {
      const existing = await (tc as any).messages.fetch(record.controlPanelMsgId).catch(() => null)
      if (!existing) {
        await db.update(autoChannels).set({ controlPanelMsgId: null }).where(eq(autoChannels.voiceChannelId, record.voiceChannelId))
        await postOrUpdateControlPanel(client, { ...record, controlPanelMsgId: null })
        result.panels++
      }
    }
  }

  // Restore in-progress cleanup timers from DB
  await restoreScheduledCleanups(client)

  // --- Reconcile hubs ---
  const hubs = await db.select().from(hubChannels).where(eq(hubChannels.guildId, guild.id))

  for (const hub of hubs) {
    const vc = await guild.channels.fetch(hub.channelId).catch(() => null)
    if (!vc) {
      // Hub gone — recreate it
      try {
        const newHub = await guild.channels.create({
          name: hub.label,
          type: ChannelType.GuildVoice,
          parent: hub.categoryId,
          position: hub.position,
        })
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

  logger.info(`Reconciler complete: recovered=${result.recovered} cleaned=${result.cleaned} hubs=${result.hubs} panels=${result.panels}`)
  return result
}
