import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core'

/**
 * #36 — Roles applied to every new member on guildMemberAdd. Gated by the
 * `feature.auto_role_on_join` boolean (default OFF). Sudo manages the list
 * via /sudo → Settings → Auto Roles.
 */
export const autoJoinRoles = pgTable('auto_join_roles', {
  roleId: text('role_id').primaryKey(),
  guildId: text('guild_id').notNull(),
  addedAt: timestamp('added_at').notNull().defaultNow(),
  addedByUserId: text('added_by_user_id'),
}, t => ({
  guildIdx: index('auto_join_roles_guild_idx').on(t.guildId),
}))

/**
 * #38 — Curated list of color-only roles. Member runs /color and picks
 * one; bot swaps any existing color-role they hold for the new pick.
 * Hidden behind feature.color_roles, default OFF.
 */
export const colorRoles = pgTable('color_roles', {
  roleId: text('role_id').primaryKey(),
  guildId: text('guild_id').notNull(),
  label: text('label').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  addedAt: timestamp('added_at').notNull().defaultNow(),
}, t => ({
  guildIdx: index('color_roles_guild_idx').on(t.guildId),
}))
