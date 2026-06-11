import { ActivityType, type Client } from 'discord.js'
import { getSetting, setSetting } from './settings'
import { logger } from './logger'

/** After 60 min of no user-initiated activity, the bot flips to idle. */
const IDLE_AFTER_MS = 60 * 60 * 1000

/**
 * `bot_settings` key for the persisted "last used" timestamp. Stored as an
 * ISO string. Survives container recreation (DB has its own docker volume),
 * unlike a file in cwd, which a `docker compose up -d` deploy would wipe.
 */
const LAST_USED_SETTING_KEY = 'presence.last_used_at'

/**
 * Throttle the presence-update push to once every 5 minutes. The status text
 * carries a relative timestamp ("/help • Xm ago") — refreshing more often
 * than once per minute is wasted work AND risks bumping into Discord's
 * PRESENCE_UPDATE rate limit (~5 per 20 s per shard ≈ 4 s/update floor).
 * 5 minutes is far above the floor and matches the granularity of the
 * displayed text. Updates that arrive during the throttle window coalesce —
 * the next push carries the latest `_lastUsedAt`.
 */
const MIN_PRESENCE_INTERVAL_MS = 5 * 60 * 1000

let _client: Client | null = null
let _idleTimer: ReturnType<typeof setTimeout> | null = null
let _currentStatus: 'online' | 'idle' | 'dnd' = 'online'
let _lastUsedAt: Date | null = null
let _lastPresenceUpdateAt = 0
let _pendingRefresh: ReturnType<typeof setTimeout> | null = null
let _periodicTicker: ReturnType<typeof setInterval> | null = null
let _lastPushedActivityText: string | null = null

export function initPresence(client: Client): void {
  _client = client
  // Reads from settings cache — caller must `await loadSettings()` before
  // `initPresence` so the persisted stamp is available on first push.
  _lastUsedAt = readPersistedLastUsedAt()
  setOnline()
  // Without a periodic re-push, the relative-time string ("4m ago") freezes
  // at whatever was last sent — Discord doesn't recompute relative times in
  // activity strings. Tick at the throttle interval and re-push only when
  // the rendered text would actually change.
  if (!_periodicTicker) {
    _periodicTicker = setInterval(periodicTick, MIN_PRESENCE_INTERVAL_MS)
    _periodicTicker.unref?.()
  }
}

/** Stop the periodic tick (test cleanup / SIGTERM handler). */
export function shutdownPresence(): void {
  if (_periodicTicker) { clearInterval(_periodicTicker); _periodicTicker = null }
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null }
  if (_pendingRefresh) { clearTimeout(_pendingRefresh); _pendingRefresh = null }
}

/**
 * Re-push the current presence. Discord drops a bot's activity on every
 * gateway disconnect/resume; without re-pushing on reconnect, the "/help • Xm"
 * text vanishes until the next user-initiated `recordActivity()`. Called from
 * the `shardResume` / `shardReady` hooks in the ready event.
 */
export function refreshPresence(): void {
  if (!_client?.user) return
  _lastPushedActivityText = null
  if (_currentStatus === 'dnd') return
  if (_currentStatus === 'idle') {
    _client.user.setPresence({ status: 'idle', activities: buildActivities() })
  } else {
    _client.user.setPresence({ status: 'online', activities: buildActivities() })
  }
  _lastPresenceUpdateAt = Date.now()
  _lastPushedActivityText = buildActivityName()
}

function periodicTick(): void {
  if (!_client?.user) return
  if (_currentStatus === 'dnd') return  // DND text is static; nothing to refresh.
  const next = buildActivityName()
  if (next === _lastPushedActivityText) return  // bucket unchanged, skip
  if (_currentStatus === 'idle') {
    _client.user.setPresence({ status: 'idle', activities: buildActivities() })
  } else {
    _client.user.setPresence({ status: 'online', activities: buildActivities() })
  }
  _lastPresenceUpdateAt = Date.now()
  _lastPushedActivityText = next
}

export function setOnline(): void {
  if (!_client?.user) return
  _currentStatus = 'online'
  pushPresenceNow('online')
  resetIdleTimer()
}

export function setIdle(): void {
  if (!_client?.user) return
  _currentStatus = 'idle'
  // Idle status keeps the relative-time stamp visible so anyone glancing
  // at the bot's profile sees the freshness even when it's gone idle.
  _client.user.setPresence({
    status: 'idle',
    activities: buildActivities(),
  })
  _lastPresenceUpdateAt = Date.now()
  _lastPushedActivityText = buildActivityName()
  persistLastUsedAt()
}

export function setDnd(reason = 'Check logs for errors'): void {
  if (!_client?.user) return
  _currentStatus = 'dnd'
  cancelIdleTimer()
  _client.user.setPresence({
    status: 'dnd',
    activities: [{ name: reason, state: reason, type: ActivityType.Custom }],
  })
  _lastPresenceUpdateAt = Date.now()
}

/**
 * Mark the bot as having just done something user-initiated. Updates
 * `_lastUsedAt`, refreshes the idle timer, and (throttled) pushes a new
 * presence with the relative timestamp baked into the activity name.
 */
export function recordActivity(): void {
  // Don't override DND — errors require manual restart to resolve.
  if (_currentStatus === 'dnd') return
  _lastUsedAt = new Date()
  if (_currentStatus === 'idle') {
    setOnline()
    return
  }
  resetIdleTimer()
  scheduleOnlineRefresh()
}

function scheduleOnlineRefresh(): void {
  if (_currentStatus !== 'online') return
  const now = Date.now()
  const since = now - _lastPresenceUpdateAt
  if (since >= MIN_PRESENCE_INTERVAL_MS) {
    pushPresenceNow('online')
    return
  }
  // Coalesce — if a refresh is already scheduled it will pick up the latest
  // _lastUsedAt when it fires.
  if (_pendingRefresh) return
  _pendingRefresh = setTimeout(() => {
    _pendingRefresh = null
    if (_currentStatus === 'online') pushPresenceNow('online')
  }, MIN_PRESENCE_INTERVAL_MS - since)
}

function pushPresenceNow(status: 'online'): void {
  if (!_client?.user) return
  _lastPresenceUpdateAt = Date.now()
  _client.user.setPresence({
    status,
    activities: buildActivities(),
  })
  _lastPushedActivityText = buildActivityName()
  persistLastUsedAt()
}

function buildActivities() {
  const text = buildActivityName()
  if (!text) return []
  // ActivityType.Custom suppresses Discord's verb prefix ("Watching ..."),
  // showing just the `state` text. `name` is required by the API but ignored
  // for display on Custom activities.
  return [{ name: text, state: text, type: ActivityType.Custom }]
}

function buildActivityName(): string {
  if (!_lastUsedAt) return '/help'
  return `/help • ${formatRelative(_lastUsedAt)}`
}

function readPersistedLastUsedAt(): Date | null {
  const raw = getSetting(LAST_USED_SETTING_KEY)
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

function persistLastUsedAt(): void {
  if (!_lastUsedAt) return
  // Fire-and-forget — presence still works in-memory if the write fails;
  // we just won't survive a restart cleanly. `audit: false`: this key is
  // internal bookkeeping rewritten every few minutes while the bot is in
  // use — auditing it would grow `setting_changes` and spam the
  // `setting_changed` event channel forever with zero operator value.
  const value = _lastUsedAt.toISOString()
  setSetting(LAST_USED_SETTING_KEY, value, undefined, { audit: false }).catch(err => {
    logger.warn('Failed to persist presence.last_used_at', err)
  })
}

function formatRelative(d: Date): string {
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))
  if (sec < 5)    return 'just now'
  if (sec < 60)   return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60)   return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24)    return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

function resetIdleTimer(): void {
  cancelIdleTimer()
  _idleTimer = setTimeout(() => {
    _idleTimer = null
    setIdle()
  }, IDLE_AFTER_MS)
}

function cancelIdleTimer(): void {
  if (_idleTimer) {
    clearTimeout(_idleTimer)
    _idleTimer = null
  }
}
