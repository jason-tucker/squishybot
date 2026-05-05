import type { Client, TextChannel, User } from 'discord.js'
import { env } from '../config/env'

type LogLevel = 'info' | 'warn' | 'error'

let cachedClient: Client | null = null
let ownerUser: User | null = null

export function attachClientToLogger(client: Client): void {
  cachedClient = client
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
  await user.send({ content: content.slice(0, 2000), flags } as any).catch(() => {})
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
        await channel.send({ content: message.slice(0, 2000) })
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
      await dmOwner(c, `❌ **${message}**\n\`\`\`\n${errStr.slice(0, 1500)}\n\`\`\``)
    }
  },
}
