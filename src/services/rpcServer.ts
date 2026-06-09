/**
 * Bot-side Redis command-bus subscriber (Wave 7).
 *
 * Botpanel publishes commands on `cmd.squishy.<verb>` with an HMAC-signed
 * envelope; we recompute the digest, replay-check, dispatch to a verb
 * handler from the registry, and publish the reply on `res.<requestId>`.
 *
 * Design rules — mirror the publisher (`eventBus.ts`) for consistency:
 *  - Lazy-singleton ioredis SUBSCRIBER. Separate from the eventBus
 *    publisher because ioredis enters subscriber mode after the first
 *    subscribe and can't be used to publish.
 *  - Non-blocking startup. If Redis is down, the bot keeps running and
 *    ioredis retries forever (capped backoff). `enableOfflineQueue: false`
 *    so commands don't queue up during outages.
 *  - Replies go through the existing eventBus publisher (`publish(...)`)
 *    — don't open a third connection.
 *  - Replay guard: 30s timestamp window + in-memory LRU of recent
 *    requestIds (cap 5000, insertion-order trim).
 *  - HMAC mismatch → drop silently + warn. Never reply with `invalid-hmac`
 *    — that would leak verification timing to an attacker.
 *  - Unknown verb → reply `{ ok: false, error: 'unknown-verb' }` so the
 *    panel sees a real error instead of timing out.
 *  - Handler exceptions → reply `{ ok: false, error: 'handler-threw' }`
 *    + log; never crash the subscriber.
 */
import Redis, { type RedisOptions } from 'ioredis'
import type { Client } from 'discord.js'
import { logger } from './logger'
import { env } from '../config/env'
import { hmacSha256, timingSafeCompare } from '../utils/hmac'
import { getVerb } from './rpc/registry'
import { publish } from './eventBus'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379'
const REPLAY_WINDOW_MS = 30_000
const REPLAY_CACHE_MAX = 5_000
const CMD_PATTERN = 'cmd.squishy.*'

// ---------------------------------------------------------------------------
// Replay cache — insertion-ordered Map for cheap LRU trim.
// ---------------------------------------------------------------------------

const recentRequestIds = new Map<string, number>()

function rememberRequestId(id: string): void {
  recentRequestIds.set(id, Date.now())
  // Map preserves insertion order; trim the oldest entries past the cap.
  while (recentRequestIds.size > REPLAY_CACHE_MAX) {
    const oldest = recentRequestIds.keys().next().value
    if (oldest === undefined) break
    recentRequestIds.delete(oldest)
  }
}

// ---------------------------------------------------------------------------
// Lazy-singleton subscriber.
// ---------------------------------------------------------------------------

let subscriber: Redis | null = null
let warnedDown = false

function getSubscriber(): Redis {
  if (subscriber) return subscriber

  const opts: RedisOptions = {
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
    maxRetriesPerRequest: 1,
    // Don't queue subscribe commands during an outage — re-subscribe on
    // the 'ready' event instead so state is explicit.
    enableOfflineQueue: false,
  }

  const r = new Redis(REDIS_URL, opts)

  r.on('connect', () => {
    if (warnedDown) {
      logger.info(`rpcServer: reconnected to Redis at ${REDIS_URL}`)
      warnedDown = false
    } else {
      logger.info(`rpcServer: connected to Redis at ${REDIS_URL}`)
    }
  })
  r.on('ready', () => {
    r.psubscribe(CMD_PATTERN).then(() => {
      logger.info(`rpcServer: psubscribed to ${CMD_PATTERN}`)
    }).catch((err: Error) => {
      logger.warn(`rpcServer: psubscribe failed: ${err.message}`)
    })
  })
  r.on('error', (err: Error) => {
    if (!warnedDown) {
      logger.warn(`rpcServer: Redis error: ${err.message}`)
      warnedDown = true
    }
  })
  r.on('end', () => {
    if (!warnedDown) {
      logger.warn('rpcServer: Redis connection ended')
      warnedDown = true
    }
  })

  r.connect().catch(() => {})

  subscriber = r
  return r
}

// ---------------------------------------------------------------------------
// Envelope handling.
// ---------------------------------------------------------------------------

type Envelope = {
  requestId: string
  ts: number
  hmac: string
  params: unknown
}

function isValidEnvelope(obj: unknown): obj is Envelope {
  if (!obj || typeof obj !== 'object') return false
  const e = obj as Record<string, unknown>
  return (
    typeof e.requestId === 'string' && e.requestId.length > 0 &&
    typeof e.ts === 'number' && Number.isFinite(e.ts) &&
    typeof e.hmac === 'string' && e.hmac.length > 0 &&
    'params' in e
  )
}

function verbFromChannel(channel: string): string | null {
  const prefix = 'cmd.squishy.'
  if (!channel.startsWith(prefix)) return null
  const verb = channel.slice(prefix.length)
  return verb.length > 0 ? verb : null
}

async function dispatch(client: Client, channel: string, message: string, secret: string): Promise<void> {
  let envelope: Envelope
  try {
    const parsed: unknown = JSON.parse(message)
    if (!isValidEnvelope(parsed)) {
      logger.warn(`rpcServer: malformed envelope on ${channel}`)
      return
    }
    envelope = parsed
  } catch (err) {
    logger.warn(`rpcServer: JSON parse failed on ${channel}: ${(err as Error).message}`)
    return
  }

  // HMAC check — compute over the canonical wire string and constant-time
  // compare. Drop silently on mismatch (no reply) so an attacker can't
  // distinguish "bad signature" from "channel doesn't exist".
  const wire = `${channel}|${envelope.requestId}|${envelope.ts}|${JSON.stringify(envelope.params)}`
  const expected = hmacSha256(secret, wire)
  if (!timingSafeCompare(expected, envelope.hmac)) {
    logger.warn(`rpcServer: HMAC mismatch on ${channel} (requestId=${envelope.requestId})`)
    return
  }

  // Replay window — both the absolute timestamp gate and the single-use
  // requestId cache. We do the cheaper window check first.
  const now = Date.now()
  if (Math.abs(now - envelope.ts) > REPLAY_WINDOW_MS) {
    logger.warn(`rpcServer: stale envelope on ${channel} (skew=${now - envelope.ts}ms)`)
    return
  }
  if (recentRequestIds.has(envelope.requestId)) {
    logger.warn(`rpcServer: duplicate requestId ${envelope.requestId} on ${channel}`)
    return
  }
  rememberRequestId(envelope.requestId)

  const verb = verbFromChannel(channel)
  if (!verb) {
    logger.warn(`rpcServer: unparseable channel ${channel}`)
    return
  }

  const replyChannel = `res.${envelope.requestId}`
  const handler = getVerb(verb)
  if (!handler) {
    await publish(replyChannel, { ok: false, error: 'unknown-verb' })
    return
  }

  try {
    const result = await handler(envelope.params, { client, requestId: envelope.requestId, ts: envelope.ts })
    await publish(replyChannel, result)
  } catch (err) {
    logger.error(`rpcServer: handler '${verb}' threw`, err)
    await publish(replyChannel, { ok: false, error: 'handler-threw', details: (err as Error)?.message })
  }
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Start the command-bus subscriber. Safe to call multiple times — the
 * underlying ioredis singleton dedupes. If `BOTPANEL_RPC_SECRET` is
 * unset, we log a warning and skip subscribing entirely so the bot still
 * runs in dev / local without the panel.
 */
export function startRpcServer(client: Client): void {
  const secret = env.BOTPANEL_RPC_SECRET
  if (!secret) {
    logger.warn('rpcServer: BOTPANEL_RPC_SECRET unset — command bus disabled')
    return
  }

  // H6: the command bus carries privileged verbs (grant roles, manage channels).
  // HMAC protects against forgery, but an unauthenticated Redis on the shared
  // botpanel-net lets a co-tenant eavesdrop/DoS the bus. Nudge operators to use
  // an authenticated URL (redis://:password@host + `requirepass`).
  if (!/^rediss?:\/\/[^@/]*:[^@/]+@/.test(REDIS_URL)) {
    logger.warn('rpcServer: REDIS_URL has no password — the command bus relies on BOTPANEL_RPC_SECRET alone. Enable Redis AUTH (requirepass) and use redis://:<password>@host so a co-tenant on the shared network cannot read/inject bus traffic.')
  }

  const r = getSubscriber()

  // ioredis fires 'pmessage' for psubscribe matches. Body wrapped in a
  // try/catch boundary so a single malformed envelope can't crash the
  // listener (which would silently break ALL future commands).
  r.on('pmessage', (_pattern: string, channel: string, message: string) => {
    void dispatch(client, channel, message, secret).catch((err: unknown) => {
      logger.error(`rpcServer: dispatch failed on ${channel}`, err)
    })
  })
}

// ---------------------------------------------------------------------------
// Re-exports for follow-up PRs.
// ---------------------------------------------------------------------------

export { registerVerb, type VerbContext, type VerbHandler, type VerbResult } from './rpc/registry'
