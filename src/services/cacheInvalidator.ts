/**
 * Cache-invalidation subscriber. Listens on `bot.squishy.settings.invalidate`
 * for fire-and-forget events from botpanel telling us a row we cache in
 * memory was just mutated, and reloads the relevant cache.
 *
 * Why this exists: without it, panel edits to `bot_settings` (welcome/goodbye
 * templates, staff role mappings, channel IDs, …) only take effect after a
 * full bot restart. Tracked as #33 / V3-1 on the botpanel side.
 *
 * Envelope shape (panel-side `web/src/lib/events/invalidate.ts`):
 *   { ts: number, hmac: string, params: { table: string, key?: string } }
 *   hmac = HMAC-SHA256(BOTPANEL_RPC_SECRET, `${channel}|${ts}|${stringified-params}`)
 *
 * Note: this envelope is *not* the same shape as the rpcServer envelope
 * (which carries `requestId` for request/reply). Invalidate is one-way,
 * idempotent, fire-and-forget — no requestId, no replay window check
 * (calling `loadSettings()` twice is harmless).
 *
 * Posture:
 *  - Bad HMAC → drop silently + warn. Same as rpcServer.
 *  - Missing `BOTPANEL_RPC_SECRET` → don't subscribe at all, log once at
 *    startup. The bot still boots and runs; cache invalidation is just off.
 *  - Reload errors are caught and warned; never crash the bot.
 */
import Redis, { type RedisOptions } from 'ioredis'
import { env } from '../config/env'
import { logger } from './logger'
import { hmacSha256, timingSafeCompare } from '../utils/hmac'
import { loadSettings } from './settings'

const CHANNEL = 'bot.squishy.settings.invalidate'

type InvalidateEnvelope = {
  ts: number
  hmac: string
  params: { table?: unknown; key?: unknown }
}

function isValidEnvelope(obj: unknown): obj is InvalidateEnvelope {
  if (!obj || typeof obj !== 'object') return false
  const e = obj as Record<string, unknown>
  return (
    typeof e.ts === 'number' && Number.isFinite(e.ts) &&
    typeof e.hmac === 'string' && e.hmac.length > 0 &&
    typeof e.params === 'object' && e.params !== null
  )
}

async function handleInvalidate(params: { table?: unknown; key?: unknown }): Promise<void> {
  const table = typeof params.table === 'string' ? params.table : ''
  const key = typeof params.key === 'string' ? params.key : undefined
  switch (table) {
    case 'bot_settings':
      // bot_settings is a flat KV table — reloading is one query, no point
      // in trying to surgically invalidate. `key` is logged for traceability.
      logger.info(`cacheInvalidator: reload bot_settings (key=${key ?? '*'})`)
      await loadSettings()
      return
    case '':
      logger.warn('cacheInvalidator: envelope had no table — ignoring')
      return
    default:
      // Unknown table → no-op for now. Future tables (`games`, `hub_channels`,
      // `auto_thread_channels`, `social_feeds`) will add cases here.
      logger.warn(`cacheInvalidator: unknown table ${table} — no-op`)
      return
  }
}

let subscriber: Redis | null = null

export function startCacheInvalidator(): void {
  if (!env.BOTPANEL_RPC_SECRET) {
    logger.warn('cacheInvalidator: BOTPANEL_RPC_SECRET unset — cache-invalidate subscriber DISABLED. Panel edits to bot_settings will require a bot restart to take effect.')
    return
  }
  if (subscriber) {
    logger.warn('cacheInvalidator: already started — ignoring duplicate start')
    return
  }
  const opts: RedisOptions = {
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
    enableOfflineQueue: true,
  }
  const r = new Redis(env.REDIS_URL ?? 'redis://redis:6379', opts)
  r.on('error', (err: Error) => {
    logger.warn(`cacheInvalidator: subscriber error: ${err.message}`)
  })
  r.on('message', async (channel: string, message: string) => {
    if (channel !== CHANNEL) return
    let envelope: InvalidateEnvelope
    try {
      const parsed: unknown = JSON.parse(message)
      if (!isValidEnvelope(parsed)) {
        logger.warn(`cacheInvalidator: malformed envelope on ${channel}`)
        return
      }
      envelope = parsed
    } catch (err) {
      logger.warn(`cacheInvalidator: JSON parse failed on ${channel}: ${(err as Error).message}`)
      return
    }
    const wire = `${channel}|${envelope.ts}|${JSON.stringify(envelope.params)}`
    const expected = hmacSha256(env.BOTPANEL_RPC_SECRET!, wire)
    if (!timingSafeCompare(expected, envelope.hmac)) {
      logger.warn(`cacheInvalidator: HMAC mismatch on ${channel} — dropping`)
      return
    }
    try {
      await handleInvalidate(envelope.params)
    } catch (err) {
      logger.warn(`cacheInvalidator: handler error: ${(err as Error)?.message ?? err}`)
    }
  })
  r.connect()
    .then(() => r.subscribe(CHANNEL))
    .then(() => {
      logger.info(`cacheInvalidator: subscribed to ${CHANNEL}`)
    })
    .catch((err: Error) => {
      logger.warn(`cacheInvalidator: subscribe failed: ${err.message}`)
    })
  subscriber = r
}
