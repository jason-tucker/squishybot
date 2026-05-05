import { pgTable, text, uuid, timestamp, boolean, integer } from 'drizzle-orm/pg-core'

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
  autoNameEnabled: boolean('auto_name_enabled').notNull().default(true),
  manualName: text('manual_name'),
  // Template tracking: null=manual, 'auto'=presence-based, 'counter'=show [x/y] member count
  nameTemplate: text('name_template'),
  controlPanelMsgId: text('control_panel_msg_id'),
  scheduledCleanupAt: timestamp('scheduled_cleanup_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastActiveAt: timestamp('last_active_at').notNull().defaultNow(),
})
