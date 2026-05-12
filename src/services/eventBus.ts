/**
 * Redis event publisher — bot-side fan-out to botpanel and any other
 * downstream consumer.
 *
 * Channel scheme: `bot.<bot>.<domain>.<event>` (per botpanel wiki).
 *   For squishybot: `bot.squishy.voice.member_join`, etc.
 *
 * Design rules:
 * - Publisher only. No subscriber here (V3 adds a cache-invalidation
 *   subscriber).
 * - Lazy connect via ioredis (`lazyConnect: true`) so the bot still boots if
 *   Redis is down. Reconnect retries are bounded with exponential backoff.
 * - `publish()` NEVER throws upstream — call sites are on the hot path and
 *   must not be coupled to Redis health. Errors are logged via `logger.warn`.
 * - All payloads JSON-encoded. `ts` is always an ISO-8601 string for
 *   wire-format stability; downstream parses it cheaply.
 */
import Redis, { type RedisOptions } from 'ioredis'
import type { Client } from 'discord.js'
import { logger } from './logger'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379'
const BOT_NAME = 'squishy'

// ---------------------------------------------------------------------------
// Lazy singleton publisher
// ---------------------------------------------------------------------------

let publisher: Redis | null = null
let warnedDown = false

function getPublisher(): Redis {
  if (publisher) return publisher

  const opts: RedisOptions = {
    lazyConnect: true,
    // Keep retrying forever but cap delay so we don't burn CPU when Redis is
    // gone for a long time. ioredis runs this on each retry attempt.
    retryStrategy: (times) => Math.min(times * 500, 10_000),
    // Without this, queued commands accumulate forever during outages and
    // burst-fire when Redis returns. Cap to 1024 so we shed load gracefully.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
  }

  const r = new Redis(REDIS_URL, opts)

  r.on('connect', () => {
    if (warnedDown) {
      logger.info(`eventBus: reconnected to Redis at ${REDIS_URL}`)
      warnedDown = false
    } else {
      logger.info(`eventBus: connected to Redis at ${REDIS_URL}`)
    }
  })
  r.on('error', (err: Error) => {
    // Demote repeat errors to one-shot warn so a downed Redis doesn't spam
    // the log on every retry. We re-arm on successful reconnect.
    if (!warnedDown) {
      logger.warn(`eventBus: Redis error: ${err.message}`)
      warnedDown = true
    }
  })
  r.on('end', () => {
    if (!warnedDown) {
      logger.warn('eventBus: Redis connection ended')
      warnedDown = true
    }
  })

  // Kick off the initial connect in the background. Failures land on the
  // 'error' handler above; no throw upstream.
  r.connect().catch(() => {})

  publisher = r
  return r
}

// ---------------------------------------------------------------------------
// Channel-name helpers — one per top-level domain.
// ---------------------------------------------------------------------------

function ch(domain: string, event: string): string {
  return `bot.${BOT_NAME}.${domain}.${event}`
}

export const voiceCh    = (event: string): string => ch('voice', event)
export const settingsCh = (event: string): string => ch('settings', event)
export const sudoCh     = (event: string): string => ch('sudo', event)
export const memberCh   = (event: string): string => ch('member', event)
export const reportCh   = (event: string): string => ch('report', event)
export const botCh      = (event: string): string => ch('bot', event)
export const hubsCh     = (event: string): string => ch('hubs', event)
export const autoThreadCh = (event: string): string => ch('auto_thread', event)
export const socialCh   = (event: string): string => ch('social', event)
export const staffCh    = (event: string): string => ch('staff', event)

// ---------------------------------------------------------------------------
// Core publish — non-blocking, never throws.
// ---------------------------------------------------------------------------

/**
 * Publish a typed event. Always non-blocking from the caller's POV —
 * callers should `void publish(...)` or just await without try/catch.
 * Errors go to `logger.warn`, never thrown upstream.
 */
export async function publish<T>(channel: string, payload: T): Promise<void> {
  try {
    const body = JSON.stringify(payload)
    await getPublisher().publish(channel, body)
  } catch (err) {
    logger.warn(`eventBus: publish ${channel} failed: ${(err as Error)?.message ?? err}`)
  }
}

// ---------------------------------------------------------------------------
// Heartbeat — fires from ready.ts every 60s.
// ---------------------------------------------------------------------------

const BOT_START_TIME = Date.now()
let cachedVersion: string | null = null

async function botVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion
  try {
    const pkg = await import('../../package.json' as any)
    cachedVersion = (pkg as any).version ?? '?'
  } catch {
    cachedVersion = '?'
  }
  return cachedVersion!
}

/**
 * One-shot ready event at startup. Distinct from the periodic heartbeat so
 * subscribers can distinguish "the bot just came up" from "still alive".
 */
export async function publishReady(_client: Client): Promise<void> {
  const version = await botVersion()
  await publish<BotReadyEvent>(botCh('ready'), {
    version,
    uptime: 0,
    ts: new Date().toISOString(),
  })
}

/**
 * Heartbeat — call every 60s from ready.ts. Uptime is in seconds.
 */
export async function publishHeartbeat(_client: Client): Promise<void> {
  const version = await botVersion()
  await publish<BotHeartbeatEvent>(botCh('heartbeat'), {
    version,
    uptime: Math.floor((Date.now() - BOT_START_TIME) / 1000),
    ts: new Date().toISOString(),
  })
}

// ---------------------------------------------------------------------------
// Payload types — kept inline here. Botpanel has its own vendored copy and
// we'll dedupe later. Shapes mirror the SquishyBot event reference table
// in the botpanel wiki.
// ---------------------------------------------------------------------------

export interface VoiceMemberJoinEvent {
  guildId: string
  userId: string
  channelId: string
  ts: string
}
export interface VoiceMemberLeaveEvent {
  guildId: string
  userId: string
  channelId: string
  ts: string
}

export interface VoiceChannelCreatedEvent {
  voiceChannelId: string
  textChannelId: string
  ownerUserId: string
  name: string
  ts: string
}
export interface VoiceChannelDeletedEvent {
  voiceChannelId: string
  textChannelId: string
  ownerUserId: string
  name: string
  ts: string
}

export interface VoiceLockToggledEvent {
  voiceChannelId: string
  isLocked: boolean
  ts: string
}
export interface VoiceHiddenToggledEvent {
  voiceChannelId: string
  isHidden: boolean
  ts: string
}
export interface VoiceHostsChangedEvent {
  voiceChannelId: string
  op: 'add' | 'remove'
  userId: string
  ts: string
}
export interface VoiceOwnerChangedEvent {
  voiceChannelId: string
  oldOwnerUserId: string | null
  newOwnerUserId: string
  ts: string
}

export interface VoiceLockdownStartedEvent {
  hubChannelId?: string
  guildWide?: boolean
  until: string
  ts: string
}
export interface VoiceLockdownEndedEvent {
  hubChannelId?: string
  guildWide?: boolean
  ts: string
}

export interface SettingChangedEvent {
  key: string
  oldValue: string | null
  newValue: string | null
  by: string | null
  ts: string
}

export interface SudoGrantedEvent {
  userId: string
  by: string | null
  ts: string
}
export interface SudoRevokedEvent {
  userId: string
  by: string | null
  ts: string
}

export interface MemberJoinedGuildEvent {
  userId: string
  ts: string
}
export interface MemberLeftGuildEvent {
  userId: string
  ts: string
}

export interface ReportCreatedEvent {
  id: number | string
  status: 'pending'
  ts: string
}
export interface ReportApprovedEvent {
  id: number | string
  status: 'filed'
  ts: string
}
export interface ReportRejectedEvent {
  id: number | string
  status: 'dropped'
  ts: string
}

export interface BotReadyEvent {
  version: string
  uptime: number
  ts: string
}
export interface BotHeartbeatEvent {
  version: string
  uptime: number
  ts: string
}
