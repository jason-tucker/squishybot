CREATE TABLE "auto_channel_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voice_channel_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"type" text NOT NULL,
	"actor_user_id" text,
	"detail" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auto_channel_logs_vc_idx" ON "auto_channel_logs" USING btree ("voice_channel_id","created_at");