CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE TABLE "auto_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"voice_channel_id" text NOT NULL,
	"text_channel_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"host_user_ids" text[] DEFAULT '{}' NOT NULL,
	"allowed_user_ids" text[] DEFAULT '{}' NOT NULL,
	"allowed_role_ids" text[] DEFAULT '{}' NOT NULL,
	"source_hub_id" text NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"user_limit" integer DEFAULT 0 NOT NULL,
	"auto_name_enabled" boolean DEFAULT true NOT NULL,
	"manual_name" text,
	"name_template" text,
	"fallback_name" text,
	"control_panel_msg_id" text,
	"sticky_msg_id" text,
	"scheduled_cleanup_at" timestamp,
	"acting_owner_user_id" text,
	"owner_grace_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_active_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auto_channels_voice_channel_id_unique" UNIQUE("voice_channel_id"),
	CONSTRAINT "auto_channels_text_channel_id_unique" UNIQUE("text_channel_id")
);
--> statement-breakpoint
CREATE TABLE "auto_channel_members" (
	"voice_channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auto_channel_members_voice_channel_id_user_id_pk" PRIMARY KEY("voice_channel_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "hub_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"category_id" text NOT NULL,
	"position" integer NOT NULL,
	"label" text DEFAULT '➕ Create Voice' NOT NULL,
	"default_template_key" text,
	"default_manual_name" text,
	"default_user_limit" integer,
	"lockdown_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "hub_channels_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"real_name" text,
	"display_name" text,
	"birthday_month" integer,
	"birthday_day" integer,
	"birthday_year" integer,
	"birthday_pings_enabled" boolean DEFAULT true NOT NULL,
	"birthday_year_visible" boolean DEFAULT false NOT NULL,
	"staff_category" text,
	"department" text,
	"tier" text,
	"leadership_title" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"requested_data" jsonb NOT NULL,
	"approval_msg_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"review_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"role_id" text,
	"channel_id" text,
	"category_id" text,
	"ping_role_id" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"play_cooldown_seconds" integer,
	"auto_archive_days" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_game_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"game_id" uuid NOT NULL,
	"wants_view" boolean DEFAULT false NOT NULL,
	"wants_ping" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_by_discord_id" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sudo_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"added_by_discord_id" text,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "auto_thread_channels" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"name_template" text,
	"archive_duration" integer,
	"added_by_discord_id" text,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"label" text NOT NULL,
	"source_url" text NOT NULL,
	"channel_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_seen_id" text,
	"last_polled_at" timestamp,
	"last_error" text,
	"max_items_per_poll" integer DEFAULT 0 NOT NULL,
	"created_by_discord_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archive_eligible_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"category_id" text NOT NULL,
	"added_by_user_id" text,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "archive_eligible_categories_category_id_unique" UNIQUE("category_id")
);
--> statement-breakpoint
CREATE TABLE "archived_channels" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"original_category_id" text,
	"original_name" text NOT NULL,
	"archived_at" timestamp DEFAULT now() NOT NULL,
	"archived_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "setting_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"changed_by_user_id" text,
	"changed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_join_roles" (
	"role_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"added_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "color_roles" (
	"role_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"report_type" text NOT NULL,
	"description" text NOT NULL,
	"steps" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"github_issue_url" text,
	"decided_by_user_id" text,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reaction_role_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_pk" uuid NOT NULL,
	"emoji" text NOT NULL,
	"role_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reaction_role_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"anchor_role_id" text,
	"expires_at" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "reaction_role_messages_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "scheduled_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"kind" text DEFAULT 'game_night' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"spec" jsonb NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fire_at" timestamp with time zone,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"message_id" text,
	"posted_at" timestamp with time zone,
	"error" text,
	"enable_rsvp" boolean DEFAULT true NOT NULL,
	"rsvps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ownership" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_discord_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_game_prefs" ADD CONSTRAINT "user_game_prefs_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auto_channels_guild_idx" ON "auto_channels" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "auto_channels_owner_idx" ON "auto_channels" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_profiles_guild_user_uq" ON "user_profiles" USING btree ("guild_id","user_id");--> statement-breakpoint
CREATE INDEX "user_profiles_birthday_idx" ON "user_profiles" USING btree ("guild_id","birthday_month","birthday_day");--> statement-breakpoint
CREATE INDEX "staff_approvals_guild_status_idx" ON "staff_approvals" USING btree ("guild_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_game_prefs_guild_user_game_uq" ON "user_game_prefs" USING btree ("guild_id","user_id","game_id");--> statement-breakpoint
CREATE INDEX "social_feeds_guild_idx" ON "social_feeds" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "archived_channels_guild_idx" ON "archived_channels" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "setting_changes_changed_at_idx" ON "setting_changes" USING btree ("changed_at");--> statement-breakpoint
CREATE INDEX "setting_changes_key_idx" ON "setting_changes" USING btree ("key");--> statement-breakpoint
CREATE INDEX "auto_join_roles_guild_idx" ON "auto_join_roles" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "color_roles_guild_idx" ON "color_roles" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "report_log_guild_idx" ON "report_log" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "report_log_created_at_idx" ON "report_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "reaction_role_mappings_message_idx" ON "reaction_role_mappings" USING btree ("message_pk");--> statement-breakpoint
CREATE INDEX "reaction_role_messages_guild_idx" ON "reaction_role_messages" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "reaction_role_messages_expires_idx" ON "reaction_role_messages" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "scheduled_posts_due_idx" ON "scheduled_posts" USING btree ("status","fire_at");--> statement-breakpoint
CREATE INDEX "scheduled_posts_guild_idx" ON "scheduled_posts" USING btree ("guild_id");