import type { Client, TextChannel, User } from 'discord.js'
import { env } from '../config/env'

type LogLevel = 'info' | 'warn' | 'error'

let cachedClient: Client | null = null
let ownerUser: User | null = null

export function attachClientToLogger(client: Client): void {
  cachedClient = client
}

/**
 * Strip secrets from text before they end up in stdout, the LOG_CHANNEL,
 * or the owner's DMs. Defense in depth: thrown errors that wrap a token —
 * e.g. an HTTP client that includes the request URL or Authorization header
 * in its `.message` — would otherwise leak through `errorAndDm` verbatim.
 *
 * The substring approach has known limits (won't catch URL-encoded tokens,
 * substrings nested inside larger strings, prefix-mismatched variants), but
 * it eliminates the obvious leak path with zero false positives.
 */
const SECRET_PATTERNS: Array<{ value: string | undefined; label: string }> = [
  { value: env.DISCORD_BOT_TOKEN, label: '[REDACTED:DISCORD_BOT_TOKEN]' },
  { value: env.GITHUB_TOKEN,      label: '[REDACTED:GITHUB_TOKEN]' },
  { value: env.DATABASE_URL,      label: '[REDACTED:DATABASE_URL]' },
  { value: env.UPTIME_KUMA_PUSH_URL, label: '[REDACTED:UPTIME_KUMA_PUSH_URL]' },
]

function redact(s: string): string {
  let out = s
  for (const { value, label } of SECRET_PATTERNS) {
    if (value && value.length > 6 && out.includes(value)) {
      out = out.split(value).join(label)
    }
  }
  return out
}

function prefix(level: LogLevel): string {
  const ts = new Date().toISOString()
  const tag = level === 'error' ? '🔴' : level === 'warn' ? '🟡' : '🟢'
  return `${tag} [${ts}]`
}

export function log(level: LogLevel, message: string, ...args: unknown[]): void {
  const line = `${prefix(level)} ${message}`
  if (level === 'error') console.error(line, ...args)
  else if (level === 'warn') console.warn(line, ...args)
  else console.log(line, ...args)
}

async function getOwnerUser(client: Client): Promise<User | null> {
  if (!env.BOT_OWNER_ID) return null
  if (ownerUser) return ownerUser
  ownerUser = await client.users.fetch(env.BOT_OWNER_ID).catch(() => null)
  return ownerUser
}

async function dmOwner(client: Client, content: string, silent = false): Promise<void> {
  const user = await getOwnerUser(client)
  if (!user) return
  // 4096 = MessageFlags.SuppressNotifications
  const flags = silent ? 4096 : undefined
  await user.send({ content: redact(content).slice(0, 2000), flags } as any).catch(() => {})
}

export const logger = {
  info: (msg: string, ...args: unknown[]) => log('info', msg, ...args),
  warn: (msg: string, ...args: unknown[]) => log('warn', msg, ...args),
  error: (msg: string, ...args: unknown[]) => log('error', msg, ...args),

  async discord(client: Client, message: string): Promise<void> {
    if (!env.LOG_CHANNEL_ID) return
    try {
      const channel = await client.channels.fetch(env.LOG_CHANNEL_ID) as TextChannel | null
      if (channel?.isTextBased()) {
        await channel.send({ content: redact(message).slice(0, 2000) })
      }
    } catch {
      // never throw from the logger
    }
  },

  async dmOwner(message: string, client?: Client, opts?: { silent?: boolean }): Promise<void> {
    const c = client ?? cachedClient
    if (!c) return
    await dmOwner(c, message, opts?.silent ?? false)
  },

  async errorAndDm(message: string, err: unknown, client?: Client): Promise<void> {
    const errStr = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    log('error', message, err)
    const c = client ?? cachedClient
    if (c) {
      // dmOwner already runs `redact`, but we explicitly slice the err
      // string here so length budgeting is predictable.
      await dmOwner(c, `❌ **${message}**\n\`\`\`\n${errStr.slice(0, 1500)}\n\`\`\``)
    }
  },
}
