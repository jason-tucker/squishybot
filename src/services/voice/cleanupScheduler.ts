import type { Client } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { logger } from '../logger'

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function scheduleCleanup(client: Client, voiceChannelId: string): void {
  if (pendingTimers.has(voiceChannelId)) return

  const delay = env.VOICE_CLEANUP_DELAY_MS

  if (delay === 0) {
    // Instant — run on next tick, still allows a reconnect within the same event loop cycle
    db.update(autoChannels).set({ scheduledCleanupAt: new Date() }).where(eq(autoChannels.voiceChannelId, voiceChannelId)).catch(() => {})
    setImmediate(() => runCleanup(client, voiceChannelId))
    return
  }

  const scheduledAt = new Date(Date.now() + delay)

  db.update(autoChannels)
    .set({ scheduledCleanupAt: scheduledAt })
    .where(eq(autoChannels.voiceChannelId, voiceChannelId))
    .catch(() => {})

  const timer = setTimeout(async () => {
    pendingTimers.delete(voiceChannelId)
    await runCleanup(client, voiceChannelId)
  }, delay)

  pendingTimers.set(voiceChannelId, timer)
  logger.info(`Cleanup scheduled for vc=${voiceChannelId} in ${delay}ms`)
}

export function cancelCleanup(voiceChannelId: string): void {
  const timer = pendingTimers.get(voiceChannelId)
  if (timer) {
    clearTimeout(timer)
    pendingTimers.delete(voiceChannelId)
  }
  db.update(autoChannels)
    .set({ scheduledCleanupAt: null })
    .where(eq(autoChannels.voiceChannelId, voiceChannelId))
    .catch(() => {})
}

async function runCleanup(client: Client, voiceChannelId: string): Promise<void> {
  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) return

  // Verify the channel is actually empty before deleting
  const guild = client.guilds.cache.get(record.guildId)
  if (!guild) return

  const vc = await guild.channels.fetch(voiceChannelId).catch(() => null)
  if (vc?.isVoiceBased() && vc.members.size > 0) {
    // Someone rejoined — cancel cleanup
    await db.update(autoChannels).set({ scheduledCleanupAt: null }).where(eq(autoChannels.voiceChannelId, voiceChannelId))
    logger.info(`Cleanup cancelled — members rejoined vc=${voiceChannelId}`)
    return
  }

  const { deleteAutoChannel } = await import('./autoChannel')
  await deleteAutoChannel(client, record)
}

export async function restoreScheduledCleanups(client: Client): Promise<void> {
  const now = new Date()
  const scheduled = await db.select().from(autoChannels)

  for (const record of scheduled) {
    if (!record.scheduledCleanupAt) continue

    const remaining = record.scheduledCleanupAt.getTime() - now.getTime()
    if (remaining <= 0) {
      // Overdue — run immediately
      await runCleanup(client, record.voiceChannelId)
    } else {
      // Reschedule with remaining time
      const timer = setTimeout(async () => {
        pendingTimers.delete(record.voiceChannelId)
        await runCleanup(client, record.voiceChannelId)
      }, remaining)
      pendingTimers.set(record.voiceChannelId, timer)
      logger.info(`Cleanup rescheduled for vc=${record.voiceChannelId} in ${remaining}ms`)
    }
  }
}
