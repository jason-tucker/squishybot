import { pgTable, text, uuid, timestamp, integer } from 'drizzle-orm/pg-core'

export const hubChannels = pgTable('hub_channels', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  channelId: text('channel_id').notNull().unique(),
  categoryId: text('category_id').notNull(),
  position: integer('position').notNull(),
  label: text('label').notNull().default('➕ Create Voice'),
  // Per-hub defaults applied to every auto-channel spawned from this hub.
  // All three are nullable; when null, the bot's built-in default is used.
  // defaultManualName supports a {member} token (substituted to displayName).
  defaultTemplateKey: text('default_template_key'),
  defaultManualName: text('default_manual_name'),
  defaultUserLimit: integer('default_user_limit'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
