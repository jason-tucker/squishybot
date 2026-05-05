import { pgTable, text, uuid, timestamp, integer } from 'drizzle-orm/pg-core'

export const hubChannels = pgTable('hub_channels', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  channelId: text('channel_id').notNull().unique(),
  categoryId: text('category_id').notNull(),
  position: integer('position').notNull(),
  label: text('label').notNull().default('➕ Create Voice'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
