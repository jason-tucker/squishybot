import { pgTable, text, uuid, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core'

/**
 * RSS-backed social feeds the bot polls and reposts into a Discord channel.
 *
 * Each row is one source (e.g. "ITSupportRI Instagram", an rss.app feed URL,
 * the Discord channel to post into). The poller loads all enabled rows on
 * startup, fetches each on a fixed interval, dedupes by `lastSeenId`, and
 * posts new items oldest-first. `lastSeenId` is seeded on add so the
 * existing backlog isn't replayed.
 */
export const socialFeeds = pgTable('social_feeds', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  label: text('label').notNull(),
  sourceUrl: text('source_url').notNull(),
  channelId: text('channel_id').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  lastSeenId: text('last_seen_id'),
  lastPolledAt: timestamp('last_polled_at'),
  lastError: text('last_error'),
  // #29 — Max items per poll. 0 (default) means "post only the single latest
  // new item per poll". 1–3 allowed for sudo; bot owner can set higher.
  maxItemsPerPoll: integer('max_items_per_poll').notNull().default(0),
  createdByDiscordId: text('created_by_discord_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => ({
  // Settings panel + poller list-by-guild queries scan otherwise.
  guildIdx: index('social_feeds_guild_idx').on(t.guildId),
}))
