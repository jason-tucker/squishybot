import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core'

/**
 * Channels where the bot auto-creates a public thread on every non-bot,
 * non-system message. Managed at runtime via /sudo → Settings → Auto Threads.
 *
 * `nameTemplate` is a small templating string with `{author}` and `{content}`
 * placeholders. When null, the default "{author} — {content}" is used.
 *
 * `archiveDuration` is the Discord thread auto-archive duration in minutes.
 * Allowed values per Discord: 60, 1440, 4320, 10080. Defaults to 1440 (24h).
 */
export const autoThreadChannels = pgTable('auto_thread_channels', {
  channelId: text('channel_id').primaryKey(),
  guildId: text('guild_id').notNull(),
  nameTemplate: text('name_template'),
  archiveDuration: integer('archive_duration'),
  addedByDiscordId: text('added_by_discord_id'),
  addedAt: timestamp('added_at').notNull().defaultNow(),
})
