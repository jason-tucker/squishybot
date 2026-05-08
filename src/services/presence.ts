import { ActivityType, type Client } from 'discord.js'

/** After 60 min of no user-initiated activity, the bot flips to idle. */
const IDLE_AFTER_MS = 60 * 60 * 1000

/**
 * Throttle the presence-update push to once every 5 minutes. The status text
 * includes a relative "last used X ago", and Discord shows that as a "Xm ago"
 * value too — refreshing more often than once per minute is wasted work AND
 * risks bumping into Discord's PRESENCE_UPDATE rate limit (~5 per 20 s per
 * shard ≈ 4 s/update floor). 5 minutes is far above the floor and matches the
 * granularity of the displayed text. Updates that arrive during the throttle
 * window coalesce — the next push carries the latest `_lastUsedAt`.
 */
const MIN_PRESENCE_INTERVAL_MS = 5 * 60 * 1000

let _client: Client | null = null
let _idleTimer: ReturnType<typeof setTimeout> | null = null
let _currentStatus: 'online' | 'idle' | 'dnd' = 'online'
let _lastUsedAt: Date | null = null
let _lastPresenceUpdateAt = 0
let _pendingRefresh: ReturnType<typeof setTimeout> | null = null

export function initPresence(client: Client): void {
  _client = client
  setOnline()
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
  // Idle status keeps the "last used X ago" stamp visible so anyone glancing
  // at the bot's profile sees the freshness even when it's gone idle.
  _client.user.setPresence({
    status: 'idle',
    activities: [{ name: buildActivityName(), type: ActivityType.Watching }],
  })
  _lastPresenceUpdateAt = Date.now()
}

export function setDnd(reason = 'Check logs for errors'): void {
  if (!_client?.user) return
  _currentStatus = 'dnd'
  cancelIdleTimer()
  _client.user.setPresence({
    status: 'dnd',
    activities: [{ name: reason, type: ActivityType.Watching }],
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
    activities: [{ name: buildActivityName(), type: ActivityType.Watching }],
  })
}

function buildActivityName(): string {
  const base = 'auto voice channels'
  if (!_lastUsedAt) return base
  return `${base} · last used ${formatRelative(_lastUsedAt)}`
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
