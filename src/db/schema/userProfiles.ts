import { pgTable, text, uuid, timestamp, integer, boolean } from 'drizzle-orm/pg-core'

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
})
