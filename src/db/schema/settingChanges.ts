import { pgTable, text, uuid, timestamp, index } from 'drizzle-orm/pg-core'

/**
 * Audit trail for bot_settings edits — every successful setSetting /
 * clearSetting writes a row. Rendered in /sudo → Settings → Debug →
 * Audit log. Retention is manual for now (truncate by date if it gets big).
 */
export const settingChanges = pgTable('setting_changes', {
  id: uuid('id').defaultRandom().primaryKey(),
  key: text('key').notNull(),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  changedByUserId: text('changed_by_user_id'),
  changedAt: timestamp('changed_at').notNull().defaultNow(),
}, t => ({
  byTimeIdx: index('setting_changes_changed_at_idx').on(t.changedAt),
  byKeyIdx: index('setting_changes_key_idx').on(t.key),
}))
