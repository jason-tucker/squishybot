import { pgTable, text, uuid, timestamp, boolean, integer, index } from 'drizzle-orm/pg-core'

export const autoChannels = pgTable('auto_channels', {
  id: uuid('id').defaultRandom().primaryKey(),
  guildId: text('guild_id').notNull(),
  voiceChannelId: text('voice_channel_id').notNull().unique(),
  textChannelId: text('text_channel_id').notNull().unique(),
  ownerUserId: text('owner_user_id').notNull(),
  hostUserIds: text('host_user_ids').array().notNull().default([]),
  allowedUserIds: text('allowed_user_ids').array().notNull().default([]),
  allowedRoleIds: text('allowed_role_ids').array().notNull().default([]),
  sourceHubId: text('source_hub_id').notNull(),
  isLocked: boolean('is_locked').notNull().default(false),
  isHidden: boolean('is_hidden').notNull().default(false),
  userLimit: integer('user_limit').notNull().default(0),
  // Smart auto-naming on/off. A manual rename or 🎲 Randomize sets this false
  // (the name is frozen); a blank rename / Auto Name → Smart sets it true.
  autoNameEnabled: boolean('auto_name_enabled').notNull().default(true),
  manualName: text('manual_name'),
  // Auto-naming mode tracker. Only two live values now: 'auto' (Smart) or null.
  // Legacy rows may still hold old template keys (counter/squad/…) — they're
  // treated as Smart since the dedicated templates were removed.
  nameTemplate: text('name_template'),
  // Name to revert to when fewer than 2 members share a game (Smart can't pick
  // a winner). Updated on creation, manual rename, and Randomize. Stays null
  // for legacy rows; rename fallback is skipped if so.
  fallbackName: text('fallback_name'),
  controlPanelMsgId: text('control_panel_msg_id'),
  stickyMsgId: text('sticky_msg_id'),
  scheduledCleanupAt: timestamp('scheduled_cleanup_at'),
  // Owner-grace fields. When the owner leaves a non-empty channel, we keep
  // owner_user_id pointed at them and put someone else in acting_owner_user_id
  // for the duration of the grace. If they return before owner_grace_expires_at,
  // the acting owner is cleared. If they don't, the acting owner is promoted.
  actingOwnerUserId: text('acting_owner_user_id'),
  ownerGraceExpiresAt: timestamp('owner_grace_expires_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastActiveAt: timestamp('last_active_at').notNull().defaultNow(),
}, t => ({
  // /sudo Active VCs and most service-level lookups filter by guild_id.
  guildIdx: index('auto_channels_guild_idx').on(t.guildId),
  // Right-click → Manage User → "owned channels" looks up by owner.
  ownerIdx: index('auto_channels_owner_idx').on(t.ownerUserId),
}))
