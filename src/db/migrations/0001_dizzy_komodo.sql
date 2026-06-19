CREATE TABLE "self_assign_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"label" text,
	"description" text,
	"emoji" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"posted_channel_id" text,
	"posted_message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" text
);
--> statement-breakpoint
CREATE INDEX "self_assign_entries_guild_idx" ON "self_assign_entries" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "self_assign_entries_guild_kind_ref_uq" ON "self_assign_entries" USING btree ("guild_id","kind","ref_id");