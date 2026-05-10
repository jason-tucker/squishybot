import { pgTable, text, uuid, timestamp, integer, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core'

export const userProfiles = pgTable('user_profiles', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  userId: text('user_id').notNull(),
  realName: text('real_name'),
  displayName: text('display_name'),
  birthdayMonth: integer('birthday_month'),
  birthdayDay: integer('birthday_day'),
  birthdayYear: integer('birthday_year'),
  birthdayPingsEnabled: boolean('birthday_pings_enabled').notNull().default(true),
  birthdayYearVisible: boolean('birthday_year_visible').notNull().default(false),
  staffCategory: text('staff_category'),
  department: text('department'),
  tier: text('tier'),
  leadershipTitle: text('leadership_title'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, t => ({
  // One profile per (guild, user) — enforces data integrity AND serves the
  // upsert + ensureProfile path. Without this, ensureProfile races could
  // create duplicate rows on concurrent first-edits.
  guildUserUq: uniqueIndex('user_profiles_guild_user_uq').on(t.guildId, t.userId),
  // Birthday scheduler runs once a day filtering on (guildId, month, day,
  // pings_enabled). Indexing the month+day half makes the daily scan O(matches).
  birthdayIdx: index('user_profiles_birthday_idx').on(t.guildId, t.birthdayMonth, t.birthdayDay),
}))
