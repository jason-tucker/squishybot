import { ActivityType, type Client } from 'discord.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** After 60 min of no user-initiated activity, the bot flips to idle. */
const IDLE_AFTER_MS = 60 * 60 * 1000

/**
 * Persist `_lastUsedAt` to disk so the relative-time stamp survives the
 * weekly auto-restart, deploys, and crashes. Read once on init, written
 * each time we push a new presence.
 */
const STATE_FILE = resolve(process.cwd(), '.presence-state.json')

/**
 * Throttle the presence-update push to once every 5 minutes. The status text
 * is a relative timestamp ("Xm ago") — refreshing more often than once per
 * minute is wasted work AND risks bumping into Discord's PRESENCE_UPDATE rate
 * limit (~5 per 20 s per shard ≈ 4 s/update floor). 5 minutes is far above
 * the floor and matches the granularity of the displayed text. Updates that
 * arrive during the throttle window coalesce — the next push carries the
 * latest `_lastUsedAt`.
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
  _lastUsedAt = readPersistedLastUsedAt()
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
  // Idle status keeps the relative-time stamp visible so anyone glancing
  // at the bot's profile sees the freshness even when it's gone idle.
  _client.user.setPresence({
    status: 'idle',
    activities: buildActivities(),
  })
  _lastPresenceUpdateAt = Date.now()
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
  if (!_lastUsedAt) return ''
  return formatRelative(_lastUsedAt)
}

function readPersistedLastUsedAt(): Date | null {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as { lastUsedAt?: string }
    if (!parsed.lastUsedAt) return null
    const d = new Date(parsed.lastUsedAt)
    return Number.isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

function persistLastUsedAt(): void {
  if (!_lastUsedAt) return
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ lastUsedAt: _lastUsedAt.toISOString() }))
  } catch {
    // Non-fatal — presence still works in-memory; we just won't survive a restart.
  }
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
