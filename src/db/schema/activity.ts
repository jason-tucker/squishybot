import { pgTable, uuid, text, timestamp, integer, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * Activity Stats — hour-bucketed aggregates + session rows only. No message
 * content is ever stored, counts only. The whole feature is opt-in and off
 * by default (`feature.activity_stats` in bot_settings). See
 * src/services/activity/ for the tracker (live) and backfill (history).
 */

// Hour-bucketed per-user/per-channel message aggregates. No message content is
// ever stored — counts only. Written by src/services/activity/tracker.ts
// (live) and backfill.ts (history). bucket = UTC timestamp truncated to hour.
// channelName is captured at write time because many tracked channels
// (auto-voice text channels, threads) are deleted later and their IDs become
// unresolvable via Discord.
export const activityMessageStats = pgTable('activity_message_stats', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  userId: text('user_id').notNull(),
  channelId: text('channel_id').notNull(),
  channelName: text('channel_name'),
  bucket: timestamp('bucket').notNull(),
  messageCount: integer('message_count').notNull().default(0),
  wordCount: integer('word_count').notNull().default(0),
  charCount: integer('char_count').notNull().default(0),
  attachmentCount: integer('attachment_count').notNull().default(0),
  mentionCount: integer('mention_count').notNull().default(0),
  replyCount: integer('reply_count').notNull().default(0),
}, t => ({
  userChannelBucketUq: uniqueIndex('activity_msg_user_channel_bucket_uq').on(t.userId, t.channelId, t.bucket),
  bucketIdx: index('activity_msg_bucket_idx').on(t.bucket),
  channelBucketIdx: index('activity_msg_channel_bucket_idx').on(t.channelId, t.bucket),
  userBucketIdx: index('activity_msg_user_bucket_idx').on(t.userId, t.bucket),
}))

// Hour-bucketed emoji usage. kind: 'message' (emoji typed in a message),
// 'reaction_given' (user reacted; live only), 'reaction_received' (reaction
// landed on the user's message; live for cached messages + exact via
// backfill). Counts are MONOTONIC — reaction removals are NOT decremented
// (the original add's hour bucket is unknowable at removal time; decrementing
// the current bucket would corrupt unrelated rows). emojiKey: custom emoji
// ID, or the unicode sequence itself.
export const activityEmojiStats = pgTable('activity_emoji_stats', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  userId: text('user_id').notNull(),
  emojiKey: text('emoji_key').notNull(),
  emojiName: text('emoji_name'),
  custom: boolean('custom').notNull().default(false),
  kind: text('kind').notNull(),
  bucket: timestamp('bucket').notNull(),
  count: integer('count').notNull().default(0),
}, t => ({
  userEmojiKindBucketUq: uniqueIndex('activity_emoji_user_key_kind_bucket_uq').on(t.userId, t.emojiKey, t.kind, t.bucket),
  bucketIdx: index('activity_emoji_bucket_idx').on(t.bucket),
  kindBucketIdx: index('activity_emoji_kind_bucket_idx').on(t.kind, t.bucket),
}))

// One row per voice stay (join → leave). durationSeconds set at close.
// leftAt NULL = session currently open. rolledUpTo persists the hourly-rollup
// watermark so a bot restart can adopt open sessions WITHOUT double-counting
// already-rolled-up seconds into activity_voice_stats.
export const activityVoiceSessions = pgTable('activity_voice_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  userId: text('user_id').notNull(),
  channelId: text('channel_id').notNull(),
  channelName: text('channel_name'),
  joinedAt: timestamp('joined_at').notNull(),
  leftAt: timestamp('left_at'),
  durationSeconds: integer('duration_seconds'),
  rolledUpTo: timestamp('rolled_up_to'),
}, t => ({
  userJoinedIdx: index('activity_voice_sessions_user_joined_idx').on(t.userId, t.joinedAt),
  joinedIdx: index('activity_voice_sessions_joined_idx').on(t.joinedAt),
}))

// Hour-bucketed voice seconds — THE source for voice heatmaps/leaderboards.
// Incremented by the tracker's periodic rollup of open sessions and the final
// partial on close (never double-counted; rolledUpTo watermark above).
// channelName captured for the same reason as activity_message_stats.
export const activityVoiceStats = pgTable('activity_voice_stats', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  userId: text('user_id').notNull(),
  channelId: text('channel_id').notNull(),
  channelName: text('channel_name'),
  bucket: timestamp('bucket').notNull(),
  seconds: integer('seconds').notNull().default(0),
}, t => ({
  userChannelBucketUq: uniqueIndex('activity_voice_user_channel_bucket_uq').on(t.userId, t.channelId, t.bucket),
  bucketIdx: index('activity_voice_bucket_idx').on(t.bucket),
  userBucketIdx: index('activity_voice_user_bucket_idx').on(t.userId, t.bucket),
}))

// Hour-bucketed seconds per Discord "Playing" activity (game), from
// presenceUpdate. Game sessions are IN-MEMORY ONLY (no session table) — they
// do not survive a bot restart; at most one flush interval of seconds is lost
// per open game on restart. Acceptable by design.
export const activityPresenceStats = pgTable('activity_presence_stats', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  userId: text('user_id').notNull(),
  gameName: text('game_name').notNull(),
  bucket: timestamp('bucket').notNull(),
  seconds: integer('seconds').notNull().default(0),
}, t => ({
  userGameBucketUq: uniqueIndex('activity_presence_user_game_bucket_uq').on(t.userId, t.gameName, t.bucket),
  bucketIdx: index('activity_presence_bucket_idx').on(t.bucket),
  gameBucketIdx: index('activity_presence_game_bucket_idx').on(t.gameName, t.bucket),
}))

// Append-only member join/leave log. memberCount is the guild-size snapshot
// at event time — the panel's member trend reads these SNAPSHOTS (never a
// cumulative delta: bots are excluded from events but move memberCount).
export const activityMemberEvents = pgTable('activity_member_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  userId: text('user_id').notNull(),
  event: text('event').notNull(), // 'join' | 'leave'
  at: timestamp('at').notNull().defaultNow(),
  memberCount: integer('member_count'),
}, t => ({
  atIdx: index('activity_member_events_at_idx').on(t.at),
}))

// Per-channel history backfill cursor. Walks BACKWARDS (before: cursor) from
// stats.enabled_at so live tracking + backfill never double-count. Panel
// reads this table directly for progress display.
export const activityBackfillProgress = pgTable('activity_backfill_progress', {
  channelId: text('channel_id').primaryKey(),
  guildId: text('guild_id').notNull(),
  channelName: text('channel_name'),
  status: text('status').notNull().default('pending'), // pending|running|done|error|skipped
  cursorMessageId: text('cursor_message_id'),
  messagesScanned: integer('messages_scanned').notNull().default(0),
  oldestSeenAt: timestamp('oldest_seen_at'),
  error: text('error'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})
