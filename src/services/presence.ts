import { ActivityType, type Client } from 'discord.js'

const IDLE_AFTER_MS = 15 * 60 * 1000 // 15 minutes

let _client: Client | null = null
let _idleTimer: ReturnType<typeof setTimeout> | null = null
let _currentStatus: 'online' | 'idle' | 'dnd' = 'online'

export function initPresence(client: Client): void {
  _client = client
  setOnline()
}

export function setOnline(): void {
  if (!_client?.user) return
  _currentStatus = 'online'
  _client.user.setPresence({
    status: 'online',
    activities: [{ name: 'auto voice channels', type: ActivityType.Watching }],
  })
  resetIdleTimer()
}

export function setIdle(): void {
  if (!_client?.user) return
  _currentStatus = 'idle'
  _client.user.setPresence({ status: 'idle', activities: [] })
}

export function setDnd(reason = 'Check logs for errors'): void {
  if (!_client?.user) return
  _currentStatus = 'dnd'
  cancelIdleTimer()
  _client.user.setPresence({
    status: 'dnd',
    activities: [{ name: reason, type: ActivityType.Watching }],
  })
}

// Call this on any meaningful bot activity (interaction received, voice event, etc.)
export function recordActivity(): void {
  // Don't clear DND — errors require manual restart to resolve
  if (_currentStatus === 'dnd') return
  if (_currentStatus === 'idle') setOnline()
  else resetIdleTimer()
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
