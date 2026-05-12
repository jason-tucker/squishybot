import { pgTable, text, uuid, timestamp, index } from 'drizzle-orm/pg-core'

/**
 * #24 — Append-only log of every /report submission. Bot-owner triage view
 * reads recent rows. Approve/Reject updates `status` and optionally
 * `github_issue_url` when the issue is filed.
 */
export const reportLog = pgTable('report_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  reportType: text('report_type').notNull(),
  description: text('description').notNull(),
  steps: text('steps'),
  status: text('status').notNull().default('pending'),
  githubIssueUrl: text('github_issue_url'),
  decidedByUserId: text('decided_by_user_id'),
  decidedAt: timestamp('decided_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, t => ({
  byGuildIdx: index('report_log_guild_idx').on(t.guildId),
  byCreatedAtIdx: index('report_log_created_at_idx').on(t.createdAt),
}))
