import { pgTable, text, uuid, timestamp, index } from 'drizzle-orm/pg-core'

/**
 * #37 — Reaction-role messages. Each row is one Discord message the bot
 * watches. Mappings table holds (emoji, role) pairs per message.
 * `expires_at` set ⇒ temporary (game-night) mode; a daily check deletes
 * the message + row + mapping rows at expiry.
 */
export const reactionRoleMessages = pgTable('reaction_role_messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  channelId: text('channel_id').notNull(),
  messageId: text('message_id').notNull().unique(),
  // Optional anchor role — temp roles get bumped one position above this at
  // create time. Future: anchor lookup at expiry for cleanup.
  anchorRoleId: text('anchor_role_id'),
  expiresAt: timestamp('expires_at'),
  createdByUserId: text('created_by_user_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => ({
  byGuildIdx: index('reaction_role_messages_guild_idx').on(t.guildId),
  byExpiresIdx: index('reaction_role_messages_expires_idx').on(t.expiresAt),
}))

export const reactionRoleMappings = pgTable('reaction_role_mappings', {
  id: uuid('id').defaultRandom().primaryKey(),
  messagePk: uuid('message_pk').notNull(),
  // Either a unicode emoji (e.g. "🟢") or a custom-emoji ID (numeric string).
  emoji: text('emoji').notNull(),
  roleId: text('role_id').notNull(),
}, t => ({
  byMessageIdx: index('reaction_role_mappings_message_idx').on(t.messagePk),
}))
