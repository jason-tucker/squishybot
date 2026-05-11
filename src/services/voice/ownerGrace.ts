/**
 * Owner-grace scheduler.
 *
 * When a channel's owner leaves a non-empty room, we hold the owner slot for
 * them for `voice.owner_grace_ms` (default 5 min). A temporary "acting owner"
 * runs the channel during the grace, but the original owner stays in
 * `owner_user_id` so they can reclaim on rejoin and never lose text-channel
 * access. If the grace expires without their return, the acting owner gets
 * promoted to permanent owner.
 *
 * State lives in `auto_channels`:
 *   - actingOwnerUserId      — userId of the temporary driver (null when no grace)
 *   - ownerGraceExpiresAt    — absolute time the grace ends (null when no grace)
 *
 * Timers are in-memory; we restore them on bot restart from those columns.
 */
import type { Client } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { settingOrNumber } from '../settings'
import { logger } from '../logger'

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const DEFAULT_OWNER_GRACE_MS = 5 * 60_000

export function getOwnerGraceMs(): number {
  return settingOrNumber('voice.owner_grace_ms', DEFAULT_OWNER_GRACE_MS)
}

/**
 * Begin a grace window: pick an acting owner and schedule promotion.
 * Caller is responsible for updating the DB (`actingOwnerUserId`,
 * `ownerGraceExpiresAt`) and for refreshing the panel — this just owns the
 * timer. Splitting the responsibilities lets the voiceStateUpdate handler do
 * one DB write that bundles the grace state with whatever else changed.
 */
export function scheduleGracePromotion(
  client: Client,
  voiceChannelId: string,
  expiresAt: Date,
): void {
  cancelGraceTimer(voiceChannelId)
  const remaining = Math.max(0, expiresAt.getTime() - Date.now())
  const timer = setTimeout(() => {
    pendingTimers.delete(voiceChannelId)
    void promoteActingOwner(client, voiceChannelId)
  }, remaining)
  pendingTimers.set(voiceChannelId, timer)
}

export function cancelGraceTimer(voiceChannelId: string): void {
  const t = pendingTimers.get(voiceChannelId)
  if (t) {
    clearTimeout(t)
    pendingTimers.delete(voiceChannelId)
  }
}

/**
 * Grace expired without the original owner returning. Promote the acting
 * owner to real owner and clear the grace fields.
 */
async function promoteActingOwner(client: Client, voiceChannelId: string): Promise<void> {
  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) return
  if (!record.actingOwnerUserId) return  // grace already cleared (owner returned or acting left)

  const newOwner = record.actingOwnerUserId
  // The previous owner shouldn't carry over as a host — they're being demoted.
  const newHosts = record.hostUserIds.filter(id => id !== newOwner && id !== record.ownerUserId)

  await db.update(autoChannels)
    .set({
      ownerUserId: newOwner,
      hostUserIds: newHosts,
      actingOwnerUserId: null,
      ownerGraceExpiresAt: null,
    })
    .where(eq(autoChannels.voiceChannelId, voiceChannelId))
    .catch(() => {})

  logger.info(`Owner grace expired — promoted ${newOwner} (was ${record.ownerUserId}) in vc=${voiceChannelId}`)

  const updated = { ...record, ownerUserId: newOwner, hostUserIds: newHosts, actingOwnerUserId: null, ownerGraceExpiresAt: null }
  const { postOrUpdateControlPanel } = await import('./controlPanel')
  await postOrUpdateControlPanel(client, updated).catch(() => {})
}

/**
 * On bot startup, walk auto_channels and reschedule any in-flight grace.
 * Overdue ones promote immediately.
 */
export async function restoreOwnerGraces(client: Client): Promise<void> {
  const now = Date.now()
  const rows = await db.select().from(autoChannels).catch(() => [])
  for (const r of rows) {
    if (!r.actingOwnerUserId || !r.ownerGraceExpiresAt) continue
    const remaining = r.ownerGraceExpiresAt.getTime() - now
    if (remaining <= 0) {
      await promoteActingOwner(client, r.voiceChannelId)
    } else {
      scheduleGracePromotion(client, r.voiceChannelId, r.ownerGraceExpiresAt)
      logger.info(`Owner grace restored for vc=${r.voiceChannelId} (${remaining}ms remaining)`)
    }
  }
}

/**
 * Pick the acting owner from the members currently in the voice channel.
 * Honors existing hosts first (in `hostUserIds` order), then falls back to
 * the longest-tenured remaining member from `auto_channel_members`.
 *
 * Returns null when no eligible member is in the channel — caller falls back
 * to the standard instant-transfer path.
 */
export async function pickActingOwner(
  record: { ownerUserId: string; hostUserIds: string[]; voiceChannelId: string },
  presentUserIds: Set<string>,
): Promise<string | null> {
  for (const hostId of record.hostUserIds) {
    if (hostId !== record.ownerUserId && presentUserIds.has(hostId)) return hostId
  }
  const { listMembers } = await import('./voiceMembers')
  const members = await listMembers(record.voiceChannelId)
  const sorted = [...members].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
  for (const m of sorted) {
    if (m.userId !== record.ownerUserId && presentUserIds.has(m.userId)) return m.userId
  }
  return null
}
