import { pgTable, text, uuid, timestamp, boolean, jsonb, index } from 'drizzle-orm/pg-core'

/**
 * Scheduled / on-demand Components-V2 posts.
 *
 * Generic enough to back several post types (keyed by `kind`); the first
 * consumer is `game_night`, driven from the botpanel web editor. A post row
 * carries:
 *
 *  - `spec`      — the portable "message spec" JSON authored in the panel's
 *                  reusable embed editor (containers / text / sections /
 *                  separators / media / link buttons + `{{variables}}` and
 *                  literal Discord `<t:UNIX:R>` timestamps). Rendered to
 *                  discord.js builders by `services/msgspec/render.ts`.
 *  - `variables` — static variable values captured at author time (e.g. the
 *                  free-form notes / game name). Live values (host mention,
 *                  RSVP counts, the scheduled time) are computed at render.
 *  - `fire_at`   — when the scheduler should post it. NULL = manual/send-now
 *                  only (never auto-fired).
 *  - `status`    — scheduled → posting → posted | failed | canceled.
 *  - RSVP state  — `rsvps` / `ownership` JSON maps keyed by user id. Persisted
 *                  so the interactive game-night buttons survive bot restarts
 *                  (the old in-memory `/sudo → Game Night` flow lost these).
 *
 * Migrations are owned here (`0002_scheduled_posts.sql`); botpanel vendors a
 * read/query copy under `web/src/lib/db/schema/squishy/`.
 */
export const scheduledPosts = pgTable(
  'scheduled_posts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    // Post type discriminator. 'game_night' today; reserved for future kinds.
    kind: text('kind').notNull().default('game_night'),
    // Short human label for the panel list (e.g. the game name).
    title: text('title').notNull().default(''),
    // Portable MessageSpec JSON (see services/msgspec/types.ts).
    spec: jsonb('spec').notNull(),
    // Author-time static variable values: { notes, ... }.
    variables: jsonb('variables').notNull().default({}),
    // When to auto-post. NULL = manual / send-now only.
    fireAt: timestamp('fire_at', { withTimezone: true }),
    // scheduled | posting | posted | failed | canceled
    status: text('status').notNull().default('scheduled'),
    messageId: text('message_id'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    error: text('error'),
    // Game-night interactivity toggle + persisted response maps.
    enableRsvp: boolean('enable_rsvp').notNull().default(true),
    // { userId: 'in' | 'maybe' | 'out' }
    rsvps: jsonb('rsvps').notNull().default({}),
    // { userId: 'has' | 'needs' }
    ownership: jsonb('ownership').notNull().default({}),
    createdByDiscordId: text('created_by_discord_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The scheduler polls `WHERE status = 'scheduled' AND fire_at <= now()`.
    dueIdx: index('scheduled_posts_due_idx').on(t.status, t.fireAt),
    guildIdx: index('scheduled_posts_guild_idx').on(t.guildId),
  }),
)

export type ScheduledPostRow = typeof scheduledPosts.$inferSelect
export type NewScheduledPostRow = typeof scheduledPosts.$inferInsert
