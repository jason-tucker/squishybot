import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Runtime-overridable key/value settings.
 * Reads fall back to env when the key isn't present here.
 * Edited via the /sudo → Settings panel.
 */
export const botSettings = pgTable('bot_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedByDiscordId: text('updated_by_discord_id'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})
