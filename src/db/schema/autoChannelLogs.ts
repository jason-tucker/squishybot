import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core'

/**
 * Append-only activity log for a single auto/static voice channel: panel
 * actions (lock/hide/rename/claim/hosts/auto-name/…), member joins & leaves,
 * ownership transfers, and game start/stop. Surfaced via the 📜 Log button on
 * the channel's sticky. Rows are keyed by `voice_channel_id` and dropped when
 * the channel is cleaned up (mirrors `auto_channel_members`). Per-channel
 * volume is capped in `appendChannelLog` so a long-lived static channel can't
 * grow unbounded.
 */
export const autoChannelLogs = pgTable('auto_channel_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  voiceChannelId: text('voice_channel_id').notNull(),
  guildId: text('guild_id').notNull(),
  // Event discriminator — see `ChannelLogType` in services/voice/channelLog.ts.
  type: text('type').notNull(),
  // The user the entry is about / who performed it. Null for system events
  // (auto-rename, website-driven rename).
  actorUserId: text('actor_user_id'),
  // Freeform payload: game name, new channel name, etc. Null when not needed.
  detail: text('detail'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => ({
  byChannelIdx: index('auto_channel_logs_vc_idx').on(t.voiceChannelId, t.createdAt),
}))
