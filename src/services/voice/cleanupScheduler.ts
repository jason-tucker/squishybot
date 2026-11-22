import type { Client } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { logger } from '../logger'
import { settingOrNumber } from '../settings'
import { createTimerSlots } from '../../utils/concurrency'

// Keys are reserved synchronously before the first await, so two concurrent
// scheduleCleanup calls can't each arm a timer (the first would be uncancellable).
const pendingTimers = createTimerSlots()

export async function scheduleCleanup(client: Client, voiceChannelId: string): Promise<void> {
  const slot = pendingTimers.reserve(voiceChannelId)
  if (!slot) return
  try {
    await scheduleReserved(client, voiceChannelId, slot)
  } finally {
    // No-op once committed to a timer or cancelled; frees early returns/throws.
    pendingTimers.release(voiceChannelId, slot)
  }
}

async function scheduleReserved(
  client: Client,
  voiceChannelId: string,
  slot: NonNullable<ReturnType<typeof pendingTimers.reserve>>,
): Promise<void> {
  // Reconciler-adopted channels are off-limits for auto-cleanup. The
  // adopt flow stamped `source_hub_id='recovered'` on these rows; that
  // marker is the only thing distinguishing them from genuine
  // hub-created auto channels. The new reconciler doesn't adopt
  // anymore, but legacy 'recovered' rows from before that change must
  // not be deleted when empty either — a manually-created channel got
  // swept up once already and the user wants those preserved.
  const [row] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (row && row.sourceHubId === 'recovered') {
    logger.info(`Cleanup refused for vc=${voiceChannelId} — source_hub_id='recovered' (legacy adopted channel, preserved)`)
    return
  }

  // Runtime-overridable via /sudo → Settings → Voice; falls back to env.
  const delay = settingOrNumber('voice.cleanup_delay_ms', env.VOICE_CLEANUP_DELAY_MS)

  // cancelCleanup ran during the await (someone rejoined): don't schedule.
  if (!pendingTimers.holds(voiceChannelId, slot)) return

  if (delay === 0) {
    // Instant — run on next tick, still allows a reconnect within the same event loop cycle
    db.update(autoChannels).set({ scheduledCleanupAt: new Date() }).where(eq(autoChannels.voiceChannelId, voiceChannelId)).catch(() => {})
    setImmediate(() => { void runCleanupSafe(client, voiceChannelId) })
    return
  }

  const scheduledAt = new Date(Date.now() + delay)

  const timer = setTimeout(() => {
    pendingTimers.fired(voiceChannelId, timer)
    void runCleanupSafe(client, voiceChannelId)
  }, delay)
  if (!pendingTimers.commit(voiceChannelId, slot, timer)) {
    clearTimeout(timer)
    return
  }

  db.update(autoChannels)
    .set({ scheduledCleanupAt: scheduledAt })
    .where(eq(autoChannels.voiceChannelId, voiceChannelId))
    .catch(() => {})

  logger.info(`Cleanup scheduled for vc=${voiceChannelId} in ${delay}ms`)
}

export function cancelCleanup(voiceChannelId: string): void {
  pendingTimers.cancel(voiceChannelId)
  db.update(autoChannels)
    .set({ scheduledCleanupAt: null })
    .where(eq(autoChannels.voiceChannelId, voiceChannelId))
    .catch(() => {})
}

/**
 * runCleanup for timer and boot callers: a DB or Discord error is logged
 * instead of escaping as an unhandled rejection (owner DM). Never rejects.
 */
async function runCleanupSafe(client: Client, voiceChannelId: string): Promise<void> {
  try {
    await runCleanup(client, voiceChannelId)
  } catch (err) {
    logger.error(`Cleanup failed for vc=${voiceChannelId}`, err)
  }
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
    // Room is in use again: a later empty-out starts a fresh delete-retry budget.
    const { resetDeleteFailures } = await import('./autoChannel')
    resetDeleteFailures(voiceChannelId)
    logger.info(`Cleanup cancelled — members rejoined vc=${voiceChannelId}`)
    return
  }

  // Static channels: only delete the companion text channel; the VC stays.
  if (record.sourceHubId === 'static') {
    const { deleteStaticText } = await import('./autoChannel')
    await deleteStaticText(client, record)
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
      await runCleanupSafe(client, record.voiceChannelId)
    } else {
      // Reschedule with remaining time
      const timer = setTimeout(() => {
        pendingTimers.fired(record.voiceChannelId, timer)
        void runCleanupSafe(client, record.voiceChannelId)
      }, remaining)
      pendingTimers.set(record.voiceChannelId, timer)
      logger.info(`Cleanup rescheduled for vc=${record.voiceChannelId} in ${remaining}ms`)
    }
  }
}
