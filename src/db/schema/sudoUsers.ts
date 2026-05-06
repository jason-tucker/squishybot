import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Additional sudo users beyond SUDO_USER_IDS env.
 * Granted/revoked at runtime via /sudo → Settings → Sudo Users.
 * isSudo(member) checks env first, then this table (cached in memory).
 */
export const sudoUsers = pgTable('sudo_users', {
  userId: text('user_id').primaryKey(),
  addedByDiscordId: text('added_by_discord_id'),
  addedAt: timestamp('added_at').notNull().defaultNow(),
  note: text('note'),
})
