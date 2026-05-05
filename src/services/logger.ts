import type { Client, TextChannel } from 'discord.js'
import { env } from '../config/env'

type LogLevel = 'info' | 'warn' | 'error'

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
}
