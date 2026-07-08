import { and, desc, eq, notInArray } from 'drizzle-orm'
import { db } from '../../db/client'
import { autoChannelLogs } from '../../db/schema'

/**
 * Per-channel activity log. One append per interesting event; reads power the
 * 📜 Log button. Writes NEVER throw — logging must not break a hot-path voice
 * event — so every DB call is guarded.
 */

/** Event discriminators stored in `auto_channel_logs.type`. */
export type ChannelLogType =
  | 'created'        // channel (auto or static companion) came into being
  | 'join'           // a member entered the voice channel
  | 'leave'          // a member left the voice channel
  | 'game_start'     // a member started playing a game (detail = game name)
  | 'game_stop'      // a member stopped playing a game (detail = game name)
  | 'lock'           // @everyone Connect denied
  | 'unlock'         // @everyone Connect restored
  | 'hide'           // @everyone ViewChannel denied
  | 'show'           // @everyone ViewChannel restored
  | 'rename'         // manual/website rename (detail = new name)
  | 'auto_rename'    // Smart auto-naming renamed the room (detail = new name)
  | 'claim'          // a member claimed ownership via the panel
  | 'owner_transfer' // ownership moved automatically when the owner left
  | 'host_add'       // a member was granted host (actor = the new host)
  | 'host_remove'    // a member was removed as host (actor = the ex-host)
  | 'auto_on'        // Smart auto-naming turned on
  | 'auto_off'       // auto-naming turned off (name frozen)
  | 'randomize'      // name randomized (detail = new name)

export interface ChannelLogEntry {
  voiceChannelId: string
  guildId: string
  type: ChannelLogType
  /** Subject of the event (who joined / was made host / etc). Null = system. */
  actorUserId?: string | null
  /** Freeform payload — game name, new channel name, etc. */
  detail?: string | null
}

export interface ChannelLogRow {
  type: string
  actorUserId: string | null
  detail: string | null
  createdAt: Date
}

/** Keep at most this many rows per channel; older ones are pruned on append. */
const MAX_LOG_ROWS_PER_CHANNEL = 200

/**
 * Append one log entry, then prune the channel back to the newest
 * {@link MAX_LOG_ROWS_PER_CHANNEL} rows. Fire-and-forget: fully swallows
 * errors so a DB blip never surfaces on a voice/interaction hot path.
 */
export async function appendChannelLog(entry: ChannelLogEntry): Promise<void> {
  try {
    await db.insert(autoChannelLogs).values({
      voiceChannelId: entry.voiceChannelId,
      guildId: entry.guildId,
      type: entry.type,
      actorUserId: entry.actorUserId ?? null,
      // Cap freeform detail (e.g. a rich-presence game name, which clients can
      // set arbitrarily long) so one entry can't dominate the render budget.
      detail: entry.detail ? entry.detail.slice(0, 120) : null,
    })

    // Prune: delete every row for this channel that isn't among its newest N.
    // The subquery is the keep-set; NOT IN it drops the overflow. No-op until
    // the channel exceeds the cap.
    const keepIds = db
      .select({ id: autoChannelLogs.id })
      .from(autoChannelLogs)
      .where(eq(autoChannelLogs.voiceChannelId, entry.voiceChannelId))
      .orderBy(desc(autoChannelLogs.createdAt))
      .limit(MAX_LOG_ROWS_PER_CHANNEL)

    await db.delete(autoChannelLogs).where(and(
      eq(autoChannelLogs.voiceChannelId, entry.voiceChannelId),
      notInArray(autoChannelLogs.id, keepIds),
    ))
  } catch {
    // Swallowed intentionally — logging must never break the caller.
  }
}

/**
 * Fire-and-forget wrapper for hot-path call sites. Use in event handlers /
 * button handlers where you don't want to `await` the log write.
 */
export function logChannelEvent(entry: ChannelLogEntry): void {
  void appendChannelLog(entry)
}

/** Most-recent-first slice of a channel's log (default 40 rows). */
export async function listChannelLog(voiceChannelId: string, limit = 40): Promise<ChannelLogRow[]> {
  return db
    .select({
      type: autoChannelLogs.type,
      actorUserId: autoChannelLogs.actorUserId,
      detail: autoChannelLogs.detail,
      createdAt: autoChannelLogs.createdAt,
    })
    .from(autoChannelLogs)
    .where(eq(autoChannelLogs.voiceChannelId, voiceChannelId))
    .orderBy(desc(autoChannelLogs.createdAt))
    .limit(limit)
    .catch(() => [])
}

/** Drop every row for a channel — call when the channel is cleaned up. */
export async function clearChannelLog(voiceChannelId: string): Promise<void> {
  await db.delete(autoChannelLogs)
    .where(eq(autoChannelLogs.voiceChannelId, voiceChannelId))
    .catch(() => {})
}
