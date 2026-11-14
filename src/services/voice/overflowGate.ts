/**
 * AutoVoice "overflow mode" gate (opt-in, `voice.overflow_mode`, default OFF).
 *
 * When enabled, every hub voice channel is hidden from @everyone
 * (ViewChannel deny — nothing is deleted or recreated) until EVERY watched
 * "always there" voice channel is full. Once all watched channels are full the
 * deny is removed so members can see/join a hub and get a new auto room. When
 * space opens up again the hubs are hidden again.
 *
 * Watched channels: `voice.overflow_watch_channel_ids` (comma-separated, same
 * format as `voice.static_channel_ids`), falling back to the static list when
 * unset/empty. Auto rooms never count as capacity. Bots count toward "full"
 * (Discord counts them toward the user limit). A limit of 0 (unlimited) is never
 * full. If no watched channel resolves, the gate fails open (hubs shown).
 *
 * Does not touch the Connect overwrite used by hubLockdown.
 */
import { ChannelType, PermissionFlagsBits, type Client, type Guild, type VoiceBasedChannel, type VoiceState } from 'discord.js'
import { env } from '../../config/env'
import { logger } from '../logger'
import { getBoolSetting, getSetting, isAutoChannelVoice, listHubs, setSetting } from '../settings'
import { getStaticChannelIds } from './staticChannels'

export const OVERFLOW_MODE_KEY = 'voice.overflow_mode'
export const OVERFLOW_WATCH_KEY = 'voice.overflow_watch_channel_ids'
// Persisted marker: 'true' once the gate has hidden any hub. While set and the
// flag is off, every apply (boot/sweep/reconcile included) clears hub denies;
// it is cleared only after every reveal succeeded.
const ACTIVE_MARKER_KEY = 'voice.overflow_gate_active'
const BOT_HUB_ALLOW = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect

/**
 * Persist the marker. Returns false (and logs) when the DB write failed.
 * `true` is always written (no cache short-circuit) so a hide is never recorded
 * only in a cache that a concurrent clear has made stale.
 */
async function setActiveMarker(active: boolean): Promise<boolean> {
  if (!active && !getBoolSetting(ACTIVE_MARKER_KEY, false)) return true
  try {
    await setSetting(ACTIVE_MARKER_KEY, active ? 'true' : 'false', undefined, { audit: false })
    return true
  } catch (err) {
    logger.warn(`overflowGate: failed to persist marker: ${(err as Error)?.message ?? err}`)
    return false
  }
}

/**
 * Hide one hub from @everyone. Steps run in order and each must succeed before
 * the next: persist the marker, grant the bot ViewChannel+Connect, then deny
 * @everyone ViewChannel. Any failure leaves the hub visible (fail open). Never throws.
 */
async function hideHub(guild: Guild, ch: VoiceBasedChannel, reason: string): Promise<void> {
  // Without the marker a later flag-off could not clean the deny up.
  if (!(await setActiveMarker(true))) return
  const botId = guild.client.user!.id
  // The bot must keep seeing/managing the hub once @everyone is denied.
  const me = ch.permissionOverwrites.cache.get(botId)
  if (!me || !me.allow.has(BOT_HUB_ALLOW)) {
    const granted = await ch.permissionOverwrites.edit(botId, { ViewChannel: true, Connect: true })
      .then(() => true)
      .catch(err => { logger.warn(`overflowGate: failed to grant bot access on hub ${ch.id}: ${err?.message ?? err}`); return false })
    if (!granted) return
  }
  // The awaits above can overlap a hub join: never deny a hub that is becoming a room.
  if (isConvertingOrRoom(ch.id)) return
  const hid = await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false })
    .then(() => { logger.info(`overflowGate(${reason}): hid hub ${ch.id}`); return true })
    .catch(err => { logger.warn(`overflowGate: failed to hide hub ${ch.id}: ${err?.message ?? err}`); return false })
  // A conversion that started while the deny was in flight: undo it so the room
  // is not left hidden (the conversion's own clear may have landed first).
  if (hid && isConvertingOrRoom(ch.id)) {
    await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: null })
      .then(() => logger.info(`overflowGate(${reason}): undid hide on converting hub ${ch.id}`))
      .catch(err => logger.warn(`overflowGate: failed to undo hide on converting hub ${ch.id}: ${err?.message ?? err}`))
  }
}

/**
 * Called on a freshly created replacement hub, before it is registered as a
 * hub: hide it when the gate is closed. The hub is created without overwrites
 * (category inheritance), so it is briefly visible; any failure leaves it
 * visible. Never throws.
 */
export async function hideNewHubIfGateClosed(guild: Guild, ch: VoiceBasedChannel): Promise<void> {
  try {
    if (!isOverflowGateClosed(guild)) return
    await hideHub(guild, ch, 'new_hub')
  } catch (err) {
    logger.warn(`overflowGate: failed to hide new hub ${ch.id}: ${(err as Error)?.message ?? err}`)
  }
}

const DEBOUNCE_MS = 3_000
const SWEEP_MS = 60_000

// ---------------------------------------------------------------------------
// Pure decision logic (no Discord / DB access)
// ---------------------------------------------------------------------------

/** A voice channel is full when it has a limit and occupancy has reached it. */
export function isVoiceFull(userLimit: number, memberCount: number): boolean {
  return userLimit > 0 && memberCount >= userLimit
}

export interface WatchedVcState {
  userLimit: number
  memberCount: number
}

/**
 * Should hubs be visible right now (overflow mode on)?
 *  - no resolvable watched channel -> true (fail open)
 *  - every watched channel full    -> true
 *  - otherwise                     -> false
 * Cases (reasoned, not run): [] -> true; [{2,2}] -> true; [{2,1}] -> false;
 * [{2,2},{2,1}] -> false; [{2,2},{3,5}] -> true (over limit still full);
 * [{0,9}] -> false (unlimited never full).
 */
export function shouldShowHubs(watched: WatchedVcState[]): boolean {
  if (watched.length === 0) return true
  return watched.every(w => isVoiceFull(w.userLimit, w.memberCount))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function isOverflowEnabled(): boolean {
  return getBoolSetting(OVERFLOW_MODE_KEY, false)
}

function parseIds(raw: string | null): string[] {
  if (!raw) return []
  return Array.from(new Set(raw.split(',').map(s => s.trim()).filter(Boolean)))
}

/** Explicit watch list, or the static-channel list when none is set. */
export function getOverflowWatchIds(): string[] {
  const explicit = parseIds(getSetting(OVERFLOW_WATCH_KEY))
  return explicit.length > 0 ? explicit : getStaticChannelIds()
}

/** True when the watch list comes from the explicit setting (not the static fallback). */
export function hasExplicitWatchList(): boolean {
  return parseIds(getSetting(OVERFLOW_WATCH_KEY)).length > 0
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

export interface WatchedSnapshot extends WatchedVcState {
  id: string
  name: string
}

/** Resolve watched channels from the guild cache (unresolvable ids are skipped). */
export function getWatchedSnapshot(guild: Guild): WatchedSnapshot[] {
  const out: WatchedSnapshot[] = []
  for (const id of getOverflowWatchIds()) {
    const ch = guild.channels.cache.get(id)
    if (!ch || !ch.isVoiceBased()) continue
    out.push({ id, name: ch.name, userLimit: ch.userLimit ?? 0, memberCount: ch.members.size })
  }
  return out
}

/** Gate is "closed" (hubs should be hidden) iff mode is on and a watched VC has space. */
export function isOverflowGateClosed(guild: Guild): boolean {
  if (!isOverflowEnabled()) return false
  return !shouldShowHubs(getWatchedSnapshot(guild))
}

// Hubs currently being converted into a room — the gate must not re-hide them.
const convertingHubs = new Set<string>()
export function markHubConverting(id: string): void { convertingHubs.add(id) }
export function unmarkHubConverting(id: string): void { convertingHubs.delete(id) }
function isConvertingOrRoom(id: string): boolean { return convertingHubs.has(id) || isAutoChannelVoice(id) }

/**
 * H3 — called right before a hub is renamed into a room: remove the overflow
 * deny so the new room is visible (record.isHidden is false). Runs while the
 * flag is on or the marker says hubs may still be hidden (flag just turned off).
 */
export async function clearOverflowHideForConversion(guild: Guild, hub: VoiceBasedChannel): Promise<void> {
  markHubConverting(hub.id)
  if (!isOverflowEnabled() && !getBoolSetting(ACTIVE_MARKER_KEY, false)) return
  // No hasViewDeny pre-check: permissionOverwrites.edit can leave the cache stale.
  await hub.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: null })
    .catch(err => logger.warn(`overflowGate: failed to reveal converting hub ${hub.id}: ${err?.message ?? err}`))
}

function hasViewDeny(guild: Guild, ch: VoiceBasedChannel): boolean {
  const ow = ch.permissionOverwrites.cache.get(guild.roles.everyone.id)
  return !!ow && ow.deny.has(PermissionFlagsBits.ViewChannel)
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

let gateClient: Client | null = null
let running = false
let rerun = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null
let warnedNoWatch = false

/**
 * Reconcile every hub's @everyone ViewChannel overwrite with the gate state.
 * Diff-only: no REST call when the cached overwrite already matches.
 * Flag off: zero edits unless the persisted marker (`voice.overflow_gate_active`)
 * says the gate has hidden hubs; then every hub's ViewChannel deny is cleared and
 * the marker is dropped once all reveals succeeded (the sweep retries otherwise).
 */
export async function applyOverflowGate(client: Client, reason: string): Promise<void> {
  gateClient = client
  if (running) { rerun = true; return }
  running = true
  try {
    do {
      rerun = false
      await applyOnce(client, reason)
    } while (rerun)
  } catch (err) {
    logger.warn(`overflowGate: apply (${reason}) failed: ${(err as Error)?.message ?? err}`)
  } finally {
    running = false
  }
}

async function applyOnce(client: Client, reason: string): Promise<void> {
  const guild = client.guilds.cache.get(env.GUILD_ID)
  if (!guild) return
  const enabled = isOverflowEnabled()
  if (!enabled && !getBoolSetting(ACTIVE_MARKER_KEY, false)) return
  let revealFailed = false

  let hide = false
  if (enabled) {
    const watched = getWatchedSnapshot(guild)
    if (watched.length === 0) {
      if (!warnedNoWatch) {
        logger.warn('overflowGate: overflow mode is on but no watched voice channel resolved — failing open (hubs shown)')
        warnedNoWatch = true
      }
    } else {
      warnedNoWatch = false
    }
    hide = !shouldShowHubs(watched)
  }

  for (const hub of listHubs()) {
    if (isConvertingOrRoom(hub.channelId)) continue
    const ch = guild.channels.cache.get(hub.channelId)
      ?? await guild.channels.fetch(hub.channelId).catch(() => null)
    if (!ch || ch.type !== ChannelType.GuildVoice) continue
    const denied = hasViewDeny(guild, ch)
    if (hide && !denied) {
      await hideHub(guild, ch, reason)
    } else if (hide && denied && !getBoolSetting(ACTIVE_MARKER_KEY, false)) {
      // Self-heal: a hub is hidden but the marker was lost; restore it.
      await setActiveMarker(true)
    } else if (!hide && denied) {
      await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: null })
        .then(() => logger.info(`overflowGate(${reason}): revealed hub ${ch.id}`))
        .catch(err => { revealFailed = true; logger.warn(`overflowGate: failed to reveal hub ${ch.id}: ${err?.message ?? err}`) })
    }
  }
  // Flag off and every reveal succeeded: drop the marker (the sweep retries otherwise).
  // Re-read the flag: it may have been turned back on during the awaits above.
  if (!enabled && !revealFailed && !isOverflowEnabled()) await setActiveMarker(false)
}

/** Trailing debounce (~3 s): coalesces bursts of voice events into one apply. */
export function requestOverflowEval(reason: string): void {
  if (!gateClient || debounceTimer) return
  const client = gateClient
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void applyOverflowGate(client, reason)
  }, DEBOUNCE_MS)
}

/** Immediate (non-debounced) apply for explicit settings changes. No-op before boot. */
export function requestOverflowGateApply(reason: string): void {
  if (gateClient) void applyOverflowGate(gateClient, reason)
}

/** H1 — cheap sync filter for the voiceStateUpdate wrapper. */
export function noteVoiceStateForOverflow(oldState: VoiceState, newState: VoiceState): void {
  if (!gateClient || !isOverflowEnabled()) return
  if (newState.guild.id !== env.GUILD_ID) return
  const watched = getOverflowWatchIds()
  const a = oldState.channelId, b = newState.channelId
  if (a === b) return
  if ((a && watched.includes(a)) || (b && watched.includes(b))) requestOverflowEval('voice')
}

/** H4/H6 — remember the client, apply once, and start the ~60 s safety sweep. */
export function startOverflowGate(client: Client): void {
  gateClient = client
  void applyOverflowGate(client, 'boot')
  if (!sweepTimer) {
    sweepTimer = setInterval(() => { void applyOverflowGate(client, 'sweep') }, SWEEP_MS)
    sweepTimer.unref?.()
  }
}
