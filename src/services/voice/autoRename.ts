/**
 * Centralized auto-rename. Re-evaluates an auto-channel's name from current
 * presence + member state and renames if it differs from the live Discord
 * name. Three call sites trigger this: presenceUpdate (game changes),
 * voiceStateUpdate-join (new member with game) and voiceStateUpdate-leave
 * (last member with game leaves).
 *
 * Throttle: Discord's per-channel rename rate limit is 2/10 min. When a
 * rename would exceed that, we schedule a deferred retry instead of giving
 * up — so the fallback-name reverts after a member stops playing get
 * applied as soon as the bucket allows.
 */
import type { Client } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import type { AutoChannelRecord } from '../../types/voice'
import { logger } from '../logger'
import { computeAutoName, ALL_TEMPLATES } from './autoNaming'

const RENAME_COOLDOWN_MS = 10 * 60 * 1000
const lastRename = new Map<string, number>()
const pendingRetries = new Map<string, NodeJS.Timeout>()

// Set of template keys that drive renames from presence. Everything else
// (e.g. legacy 'tryhard', 'chill', or anything we don't recognize) is treated
// as manual mode and skipped — auto_name_enabled also gates this layer.
const PRESENCE_TEMPLATES = new Set<string | null>([null, ...ALL_TEMPLATES])

export function clearRenameState(voiceChannelId: string): void {
  lastRename.delete(voiceChannelId)
  const t = pendingRetries.get(voiceChannelId)
  if (t) {
    clearTimeout(t)
    pendingRetries.delete(voiceChannelId)
  }
}

/**
 * Re-evaluate the channel name. No-op when nothing needs to change. When
 * throttled, schedules itself to retry as soon as the bucket allows.
 *
 * Accepts either a voiceChannelId (we'll look up the record) or a
 * pre-fetched record. Callers in voiceStateUpdate / presenceUpdate already
 * have the record in hand; passing it directly avoids a second DB select.
 */
export async function maybeRenameChannel(
  client: Client,
  voiceChannelIdOrRecord: string | AutoChannelRecord,
): Promise<void> {
  let record: AutoChannelRecord | undefined
  if (typeof voiceChannelIdOrRecord === 'string') {
    [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelIdOrRecord))
  } else {
    record = voiceChannelIdOrRecord
  }
  if (!record) return
  const voiceChannelId = record.voiceChannelId
  if (!record.autoNameEnabled) return
  if (!PRESENCE_TEMPLATES.has(record.nameTemplate)) return

  const guild = client.guilds.cache.get(record.guildId)
  if (!guild) return
  const vc = guild.channels.cache.get(voiceChannelId)
    ?? await guild.channels.fetch(voiceChannelId).catch(() => null)
  if (!vc?.isVoiceBased()) return

  const computed = computeAutoName(vc, record.ownerUserId, record.nameTemplate)
  const desired = computed ?? record.fallbackName
  if (!desired) return
  if (vc.name === desired) return

  const elapsed = Date.now() - (lastRename.get(voiceChannelId) ?? 0)
  if (elapsed < RENAME_COOLDOWN_MS) {
    // Throttled. Schedule a single retry; coalesce subsequent calls.
    if (pendingRetries.has(voiceChannelId)) return
    const wait = RENAME_COOLDOWN_MS - elapsed + 1000  // +1 s safety margin
    pendingRetries.set(voiceChannelId, setTimeout(() => {
      pendingRetries.delete(voiceChannelId)
      void maybeRenameChannel(client, voiceChannelId)
    }, wait))
    return
  }

  lastRename.set(voiceChannelId, Date.now())
  await vc.setName(desired).catch(err =>
    logger.warn(`auto-rename: setName failed for ${voiceChannelId}: ${(err as Error).message}`),
  )

  // Keep the attached text channel in sync.
  const tc = guild.channels.cache.get(record.textChannelId)
    ?? await guild.channels.fetch(record.textChannelId).catch(() => null)
  if (tc?.isTextBased()) {
    const textName = desired.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice-chat'
    await (tc as any).setName(textName).catch(() => {})
  }

  logger.info(`Auto-rename: vc=${voiceChannelId} → ${desired}${computed === null ? ' (fallback)' : ''}`)
}
