import { pgTable, text, uuid, timestamp, index } from 'drizzle-orm/pg-core'

/**
 * Categories sudo has opted in for the channel-archive workflow. Only
 * channels inside these categories can be archived via /sudo → Archive.
 * Everything else is invisible to the scanner.
 */
export const archiveEligibleCategories = pgTable('archive_eligible_categories', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  categoryId: text('category_id').notNull().unique(),
  addedByUserId: text('added_by_user_id'),
  addedAt: timestamp('added_at').notNull().defaultNow(),
})

/**
 * Channels currently in the archived state. Used to (a) unarchive
 * (restore original name + parent category + Send permission), and (b)
 * render the "Archived channels" list in /sudo → Archive.
 */
export const archivedChannels = pgTable('archived_channels', {
  channelId: text('channel_id').primaryKey(),
  guildId: text('guild_id').notNull(),
  originalCategoryId: text('original_category_id'),
  originalName: text('original_name').notNull(),
  archivedAt: timestamp('archived_at').notNull().defaultNow(),
  archivedByUserId: text('archived_by_user_id'),
}, t => ({
  guildIdx: index('archived_channels_guild_idx').on(t.guildId),
}))
