import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Tracks when each member joined a given auto voice channel. Updated by
 * voiceStateUpdate; surfaced in the control panel's member list with a
 * relative `<t:N:R>` timestamp. On bot restart the reconciler backfills
 * any current-but-untracked members with `now()` (original times lost).
 */
export const autoChannelMembers = pgTable('auto_channel_members', {
  voiceChannelId: text('voice_channel_id').notNull(),
  userId: text('user_id').notNull(),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.voiceChannelId, t.userId] }),
}))
