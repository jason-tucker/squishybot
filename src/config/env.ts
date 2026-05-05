import { z } from 'zod'
import 'dotenv/config'

const commaSeparated = z
  .string()
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
  SUDO_ROLE_IDS: commaSeparated.default(''),
  SUDO_USER_IDS: commaSeparated.default(''),

  // Voice channels
  AUTO_VOICE_CATEGORY_ID: z.string().min(1, 'AUTO_VOICE_CATEGORY_ID is required'),
  HUB_CHANNEL_IDS: commaSeparated.pipe(
    z.array(z.string()).min(1, 'At least one HUB_CHANNEL_IDS is required')
  ),
  VOICE_CLEANUP_DELAY_MS: z.coerce.number().int().positive().default(30000),

  // Optional channel IDs — empty string treated as unset
  LOG_CHANNEL_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  ADMIN_CHANNEL_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),

  // Future features — optional now, required when those phases are built
  STAFF_APPROVAL_CHANNEL_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  BIRTHDAY_CHANNEL_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  BLIPS_CHANNEL_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  FOOD_CHANNEL_ID: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
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
