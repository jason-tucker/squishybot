import { pgTable, text, uuid, boolean, uniqueIndex } from 'drizzle-orm/pg-core'
import { games } from './games'

export const userGamePrefs = pgTable('user_game_prefs', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  userId: text('user_id').notNull(),
  gameId: uuid('game_id').notNull().references(() => games.id, { onDelete: 'cascade' }),
  wantsView: boolean('wants_view').notNull().default(false),
  wantsPing: boolean('wants_ping').notNull().default(false),
}, (t) => ({
  guildUserGameUq: uniqueIndex('user_game_prefs_guild_user_game_uq').on(t.guildId, t.userId, t.gameId),
}))
