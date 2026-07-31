CREATE TABLE "activity_backfill_progress" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"cursor_message_id" text,
	"messages_scanned" integer DEFAULT 0 NOT NULL,
	"oldest_seen_at" timestamp,
	"error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_emoji_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"emoji_key" text NOT NULL,
	"emoji_name" text,
	"custom" boolean DEFAULT false NOT NULL,
	"kind" text NOT NULL,
	"bucket" timestamp NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_member_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"event" text NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	"member_count" integer
);
--> statement-breakpoint
CREATE TABLE "activity_message_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" text,
	"bucket" timestamp NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"char_count" integer DEFAULT 0 NOT NULL,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_presence_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"game_name" text NOT NULL,
	"bucket" timestamp NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_voice_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" text,
	"joined_at" timestamp NOT NULL,
	"left_at" timestamp,
	"duration_seconds" integer,
	"rolled_up_to" timestamp
);
--> statement-breakpoint
CREATE TABLE "activity_voice_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" text,
	"bucket" timestamp NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "activity_emoji_user_key_kind_bucket_uq" ON "activity_emoji_stats" USING btree ("user_id","emoji_key","kind","bucket");--> statement-breakpoint
CREATE INDEX "activity_emoji_bucket_idx" ON "activity_emoji_stats" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "activity_emoji_kind_bucket_idx" ON "activity_emoji_stats" USING btree ("kind","bucket");--> statement-breakpoint
CREATE INDEX "activity_member_events_at_idx" ON "activity_member_events" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_msg_user_channel_bucket_uq" ON "activity_message_stats" USING btree ("user_id","channel_id","bucket");--> statement-breakpoint
CREATE INDEX "activity_msg_bucket_idx" ON "activity_message_stats" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "activity_msg_channel_bucket_idx" ON "activity_message_stats" USING btree ("channel_id","bucket");--> statement-breakpoint
CREATE INDEX "activity_msg_user_bucket_idx" ON "activity_message_stats" USING btree ("user_id","bucket");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_presence_user_game_bucket_uq" ON "activity_presence_stats" USING btree ("user_id","game_name","bucket");--> statement-breakpoint
CREATE INDEX "activity_presence_bucket_idx" ON "activity_presence_stats" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "activity_presence_game_bucket_idx" ON "activity_presence_stats" USING btree ("game_name","bucket");--> statement-breakpoint
CREATE INDEX "activity_voice_sessions_user_joined_idx" ON "activity_voice_sessions" USING btree ("user_id","joined_at");--> statement-breakpoint
CREATE INDEX "activity_voice_sessions_joined_idx" ON "activity_voice_sessions" USING btree ("joined_at");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_voice_user_channel_bucket_uq" ON "activity_voice_stats" USING btree ("user_id","channel_id","bucket");--> statement-breakpoint
CREATE INDEX "activity_voice_bucket_idx" ON "activity_voice_stats" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "activity_voice_user_bucket_idx" ON "activity_voice_stats" USING btree ("user_id","bucket");