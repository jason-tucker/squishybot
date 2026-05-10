import { pgTable, text, uuid, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const staffApprovals = pgTable('staff_approvals', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  userId: text('user_id').notNull(),
  requestedData: jsonb('requested_data').notNull(),
  approvalMsgId: text('approval_msg_id'),
  status: text('status').notNull().default('pending'),
  reviewedBy: text('reviewed_by'),
  reviewNote: text('review_note'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at'),
}, t => ({
  // /sudo home and the approvals panel filter on (guildId, status='pending')
  // every render. Without this the table scans per query.
  guildStatusIdx: index('staff_approvals_guild_status_idx').on(t.guildId, t.status),
}))
