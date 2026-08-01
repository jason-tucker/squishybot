/**
 * Activity Stats — auto-channel classification.
 *
 * Auto voice rooms (and their companion text channels) are ephemeral: the
 * channel pair is deleted as soon as the room empties, so every room that
 * ever existed leaves a unique dead channel ID behind in the activity_*
 * tables. Without classification the panel's channel lists fill up with
 * unresolvable "ghost" channels — one per room ever created.
 *
 * Three layers keep `channel_kind` correct, cheapest first:
 *  1. Record time — `classifyChannelKind` is a synchronous in-memory lookup
 *     against the auto-channel registry in services/settings.ts, safe to
 *     call from hot gateway handlers.
 *  2. Teardown — `stampActivityChannelKinds` re-stamps every stats row for a
 *     pair the moment it's deleted, catching rows that were recorded before
 *     the pair's auto_channels row existed (the creator's hub-join session).
 *  3. Startup / flag-on sweep — `sweepLegacyChannelKinds` classifies rows
 *     written before this feature existed, plus anything a crash between
 *     delete and stamp left behind.
 */
import type { Client } from 'discord.js'
import { eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../../db/client'
import { activityMessageStats, activityVoiceSessions, activityVoiceStats } from '../../db/schema'
import { env } from '../../config/env'
import { logger } from '../logger'
import { isAutoChannelText, isAutoChannelVoice } from '../settings'
import { isStaticChannel } from '../voice/staticChannels'

export type ActivityChannelKind = 'auto_voice' | 'auto_text'

/**
 * Synchronous, allocation-free classification for the record-time hot path.
 * Static VCs are deliberately NOT auto_voice — the VC itself is permanent
 * and should stay an ordinary individual channel in stats; only its
 * companion text channel (which IS in the auto-text registry) is ephemeral.
 */
export function classifyChannelKind(channelId: string): ActivityChannelKind | null {
  if (isAutoChannelText(channelId)) return 'auto_text'
  if (isAutoChannelVoice(channelId) && !isStaticChannel(channelId)) return 'auto_voice'
  return null
}

/**
 * Teardown stamp — mark every stats row for a just-deleted pair. The voice
 * ID also stamps activity_message_stats because text-in-voice chat records
 * messages under the voice channel's own ID. Unconditional (not
 * WHERE-kind-IS-NULL) so it self-heals any earlier misclassification.
 * Fire-and-forget friendly: never throws.
 */
export async function stampActivityChannelKinds(opts: {
  voiceChannelId?: string | null
  textChannelId?: string | null
}): Promise<void> {
  const { voiceChannelId, textChannelId } = opts
  try {
    if (voiceChannelId) {
      await db.update(activityVoiceStats).set({ channelKind: 'auto_voice' })
        .where(eq(activityVoiceStats.channelId, voiceChannelId))
      await db.update(activityVoiceSessions).set({ channelKind: 'auto_voice' })
        .where(eq(activityVoiceSessions.channelId, voiceChannelId))
      await db.update(activityMessageStats).set({ channelKind: 'auto_voice' })
        .where(eq(activityMessageStats.channelId, voiceChannelId))
    }
    if (textChannelId) {
      await db.update(activityMessageStats).set({ channelKind: 'auto_text' })
        .where(eq(activityMessageStats.channelId, textChannelId))
    }
  } catch (err) {
    logger.warn(`activity: channel-kind stamp failed vc=${voiceChannelId ?? '-'} tc=${textChannelId ?? '-'}: ${(err as Error).message}`)
  }
}

/**
 * Classify legacy NULL-kind rows. For every distinct un-kinded channel ID:
 *  - still classifiable via the live registry → that kind (live auto rooms
 *    whose early rows predate classification);
 *  - channel no longer exists in the guild → it was an ephemeral auto pair:
 *    voice-table rows become 'auto_voice', message rows 'auto_text'.
 *
 * Liveness includes active threads (thread messages are live-tracked under
 * the thread's own ID). Caveat, accepted: an ARCHIVED thread isn't in either
 * cache, so its rows would fold into the auto group — its name still renders
 * inside the drill-down, nothing is lost. A genuinely deleted normal channel
 * folds in too, which is exactly the de-ghosting this feature wants.
 */
export async function sweepLegacyChannelKinds(client: Client): Promise<void> {
  try {
    const guild = client.guilds.cache.get(env.GUILD_ID)
    if (!guild) {
      logger.warn(`activity: channel-kind sweep skipped — guild ${env.GUILD_ID} not in cache`)
      return
    }
    const liveIds = new Set<string>(guild.channels.cache.keys())
    const active = await guild.channels.fetchActiveThreads().catch(() => null)
    if (active) for (const id of active.threads.keys()) liveIds.add(id)

    let stamped = 0
    const sweepTable = async (
      table: typeof activityVoiceStats | typeof activityVoiceSessions | typeof activityMessageStats,
      deadKind: ActivityChannelKind,
    ): Promise<void> => {
      const rows = await db.selectDistinct({ channelId: table.channelId })
        .from(table).where(isNull(table.channelKind))
      const byKind = new Map<ActivityChannelKind, string[]>()
      for (const { channelId } of rows) {
        const kind = classifyChannelKind(channelId) ?? (liveIds.has(channelId) ? null : deadKind)
        if (!kind) continue
        const list = byKind.get(kind) ?? []
        list.push(channelId)
        byKind.set(kind, list)
      }
      for (const [kind, ids] of byKind) {
        await db.update(table).set({ channelKind: kind }).where(inArray(table.channelId, ids))
        stamped += ids.length
      }
    }

    await sweepTable(activityVoiceStats, 'auto_voice')
    await sweepTable(activityVoiceSessions, 'auto_voice')
    await sweepTable(activityMessageStats, 'auto_text')
    logger.info(`activity: channel-kind sweep complete — ${stamped} channel(s) classified`)
  } catch (err) {
    logger.warn(`activity: channel-kind sweep failed: ${(err as Error).message}`)
  }
}
