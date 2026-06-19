import { pgTable, text, integer, boolean, timestamp, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * Self-assign role board. Each row is one entry the bot posts as its own
 * Components-V2 embed (with a toggle button) into the configured self-assign
 * channel (`selfassign.channel_id` in bot_settings). Two kinds:
 *
 *   - kind='role' : `ref_id` is a Discord role snowflake. One "Add / Remove"
 *                   button toggles the role on the clicking member. Covers both
 *                   the curated self-assign list and imported auto-join roles.
 *   - kind='game' : `ref_id` is a games.id UUID. The embed gets two buttons —
 *                   Channel access (View) and LFG pings — wired through the
 *                   games prefs (`setPref`) so it does everything `/games` does.
 *
 * `posted_channel_id` / `posted_message_id` track the live Discord message so
 * the board can edit it in place or delete it. Managed from botpanel
 * (/squishy/self-assign-roles) and /sudo → Settings → Self-assign Roles.
 */
export const selfAssignEntries = pgTable('self_assign_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  // 'role' | 'game' — discriminates how ref_id is interpreted and rendered.
  kind: text('kind').notNull(),
  // Discord role snowflake (kind='role') or games.id UUID (kind='game').
  refId: text('ref_id').notNull(),
  // Optional display-name override; falls back to the role/game name.
  label: text('label'),
  // Optional extra line rendered in the embed body.
  description: text('description'),
  // Optional emoji for the toggle button (unicode or custom-emoji markup).
  emoji: text('emoji'),
  sortOrder: integer('sort_order').notNull().default(0),
  // Disabled entries stay configured but are not posted to the channel.
  enabled: boolean('enabled').notNull().default(true),
  // The live posted message, if any (null until the board is published).
  postedChannelId: text('posted_channel_id'),
  postedMessageId: text('posted_message_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  createdByUserId: text('created_by_user_id'),
}, t => ({
  guildIdx: index('self_assign_entries_guild_idx').on(t.guildId),
  // One entry per (guild, kind, ref) — can't add the same role/game twice.
  refUq: uniqueIndex('self_assign_entries_guild_kind_ref_uq').on(t.guildId, t.kind, t.refId),
}))
