import { pgTable, text, uuid, timestamp, boolean, integer } from 'drizzle-orm/pg-core'

export const games = pgTable('games', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  name: text('name').notNull(),
  roleId: text('role_id'),
  channelId: text('channel_id'),
  categoryId: text('category_id'),
  pingRoleId: text('ping_role_id'),
  isArchived: boolean('is_archived').notNull().default(false),
  isVisible: boolean('is_visible').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  aliases: text('aliases').array().notNull().default([]),
  // #22 — per-game /play cooldown in seconds. Null = use the global default
  // (1800 = 30 min). 0 = no cooldown.
  playCooldownSeconds: integer('play_cooldown_seconds'),
  // #21 — auto-archive after this many days of channel silence. Null or 0
  // disables auto-archive for the game. Reuses the archive workflow's
  // destination + mechanics — channel.archive_destination must be set.
  autoArchiveDays: integer('auto_archive_days'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
