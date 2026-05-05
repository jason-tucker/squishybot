-- SquishyBot initial schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Auto voice channels created by the hub system
CREATE TABLE IF NOT EXISTS auto_channels (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id              TEXT NOT NULL,
  voice_channel_id      TEXT NOT NULL UNIQUE,
  text_channel_id       TEXT NOT NULL UNIQUE,
  owner_user_id         TEXT NOT NULL,
  host_user_ids         TEXT[] NOT NULL DEFAULT '{}',
  allowed_user_ids      TEXT[] NOT NULL DEFAULT '{}',
  allowed_role_ids      TEXT[] NOT NULL DEFAULT '{}',
  source_hub_id         TEXT NOT NULL,
  is_locked             BOOLEAN NOT NULL DEFAULT false,
  is_hidden             BOOLEAN NOT NULL DEFAULT false,
  user_limit            INTEGER NOT NULL DEFAULT 0,
  auto_name_enabled     BOOLEAN NOT NULL DEFAULT true,
  manual_name           TEXT,
  control_panel_msg_id  TEXT,
  scheduled_cleanup_at  TIMESTAMP,
  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  last_active_at        TIMESTAMP NOT NULL DEFAULT now()
);

-- Managed hub voice channels
CREATE TABLE IF NOT EXISTS hub_channels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL UNIQUE,
  category_id TEXT NOT NULL,
  position    INTEGER NOT NULL,
  label       TEXT NOT NULL DEFAULT '➕ Create Voice',
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);

-- User profiles (staff, birthday, display name)
CREATE TABLE IF NOT EXISTS user_profiles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id         TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  real_name        TEXT,
  display_name     TEXT,
  birthday_month   INTEGER,
  birthday_day     INTEGER,
  staff_category   TEXT,
  department       TEXT,
  tier             TEXT,
  leadership_title TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(guild_id, user_id)
);

-- Staff role approval queue
CREATE TABLE IF NOT EXISTS staff_approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  requested_data  JSONB NOT NULL,
  approval_msg_id TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  reviewed_by     TEXT,
  review_note     TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMP
);

-- Game definitions
CREATE TABLE IF NOT EXISTS games (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  role_id     TEXT,
  channel_id  TEXT,
  category_id TEXT,
  ping_role_id TEXT,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  is_visible  BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  aliases     TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);

-- Per-user game preferences
CREATE TABLE IF NOT EXISTS user_game_prefs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  game_id     UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  wants_view  BOOLEAN NOT NULL DEFAULT false,
  wants_ping  BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(guild_id, user_id, game_id)
);
