import { z } from 'zod'
import 'dotenv/config'

const commaSeparated = z
  .string()
  .default('')
  .transform(s => s.split(',').map(x => x.trim()).filter(Boolean))

const envSchema = z.object({
  // Core
  DISCORD_BOT_TOKEN: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  UPTIME_KUMA_PUSH_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),

  // Guild
  GUILD_ID: z.string().min(1, 'GUILD_ID is required'),

  // Sudo permissions
  SUDO_ROLE_IDS: commaSeparated,
  SUDO_USER_IDS: commaSeparated,

  // Bot owner — receives DMs on startup and unhandled errors
  BOT_OWNER_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),

  // Voice channels
  AUTO_VOICE_CATEGORY_ID: z.string().min(1, 'AUTO_VOICE_CATEGORY_ID is required'),
  // Initial hub seed list. Once hubs are registered (DB-backed), this can be empty —
  // /sudo → Settings → Hub Channels manages the list at runtime.
  HUB_CHANNEL_IDS: commaSeparated,
  VOICE_CLEANUP_DELAY_MS: z.coerce.number().int().min(0).default(0),

  // Optional channel IDs — empty string treated as unset
  LOG_CHANNEL_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  ADMIN_CHANNEL_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),

  // Staff approvals — posts go in a thread inside the admin channel and ping a designated reviewer
  STAFF_APPROVAL_THREAD_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  STAFF_APPROVAL_PING_USER_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),

  // Future features — optional now, required when those phases are built
  BIRTHDAY_CHANNEL_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  CLIPS_CHANNEL_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  FOOD_CHANNEL_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),

  // /report — files GitHub issues from inside Discord
  GITHUB_TOKEN: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  GITHUB_REPO: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),

  // Wave 7 command bus — shared secret with botpanel for HMAC-signed
  // RPC envelopes on `cmd.squishy.<verb>`. Optional: if unset,
  // `startRpcServer` logs a warning and does not subscribe, so the bot
  // still runs in environments without the panel wired up.
  BOTPANEL_RPC_SECRET: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),

  // Website (botpanel) base URL for the "do this on the website" links appended
  // to slash command replies. Optional — panelLink.ts falls back to the prod domain.
  PANEL_BASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

export const env = parsed.data

// Non-fatal hardening nudge (M2): warn when the DB is using the weak compose
// default password. We deliberately do NOT hard-fail — that would break an
// existing deploy whose Postgres volume was initialized with this default — but
// the operator should rotate to a strong POSTGRES_PASSWORD in .env. Using
// console.warn (not the logger) to avoid an import cycle at startup; the literal
// password is intentionally not printed.
if (/:squishybot_dev@/.test(env.DATABASE_URL)) {
  console.warn(
    '⚠️  DATABASE_URL is using the weak default DB password. Set a strong POSTGRES_PASSWORD in .env and rotate the database password — the DB is reachable by every container on the shared docker network.',
  )
}
