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
 * unset/empty. Temporary auto rooms and hubs never count as capacity (static
 * channels do, even with a companion auto-channel row). Bots count toward
 * "full" (Discord counts them toward the user limit). A limit of 0 (unlimited)
 * is never full. If no watched channel resolves, the gate fails open (hubs shown).
 *
 * Ownership: the gate only ever removes a ViewChannel deny it recorded in
 * `voice.overflow_owned` (bot_settings JSON, keyed by channel id) BEFORE writing
 * it, together with the bot-member bits it added. A deny an admin set is never
 * adopted or removed. The in-memory map is the source of truth after first load.
 *
 * All @everyone writes go through hubPermWriter (per-channel lock + fresh
 * fetch), shared with hubLockdown, so the Connect bit is always preserved.
 */
import { PermissionFlagsBits, type Client, type Guild, type VoiceBasedChannel, type VoiceChannel, type VoiceState } from 'discord.js'
import { eq, inArray } from 'drizzle-orm'
import { env } from '../../config/env'
import { db } from '../../db/client'
import { autoChannels, botSettings } from '../../db/schema'
import { logger } from '../logger'
import { clearSetting, getBoolSetting, getSetting, isAutoChannelVoice, isHubChannelCached, listHubs, setSetting } from '../settings'
import { fetchFreshVoice, withChannelLock } from './hubPermWriter'
import { getStaticChannelIds, isStaticChannel } from './staticChannels'

export const OVERFLOW_MODE_KEY = 'voice.overflow_mode'
export const OVERFLOW_WATCH_KEY = 'voice.overflow_watch_channel_ids'
const OWNED_KEY = 'voice.overflow_owned'
// Boolean marker used by earlier builds of this branch; deleted on first load.
const LEGACY_MARKER_KEY = 'voice.overflow_gate_active'
const BOT_HUB_ALLOW = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect

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

export interface HubActionInput {
  /** Gate closed, channel is a listed hub (or a new hub), not converting/room. */
  wantHidden: boolean
  /** The gate recorded this channel in voice.overflow_owned. */
  owned: boolean
  /** @everyone currently denies ViewChannel (fresh state). */
  denied: boolean
  /** Converting hub or temporary auto room (not static). */
  isRoom: boolean
  /** The room owner hid it (auto_channels.isHidden). */
  roomHidden: boolean
}
export type HubAction = 'none' | 'hide' | 'release' | 'drop_record'

/**
 * What to do with one channel. 'release' = clear the View deny if present,
 * revert the bot bits the gate added (not on rooms), drop the record.
 * Cases (reasoned, not run):
 *  !owned, deny  (admin restriction)        -> none, whatever the gate wants
 *  !owned, !deny, wantHidden                -> hide;  !wantHidden -> none
 *  !owned, room                             -> none
 *  owned, wantHidden, deny                  -> none;  !deny -> hide (re-deny)
 *  owned, !wantHidden                       -> release
 *  owned, room, deny, !roomHidden           -> release (View only)
 *  owned, room, roomHidden or !deny         -> drop_record (owner's state kept)
 */
export function decideHubAction(s: HubActionInput): HubAction {
  if (!s.owned) return !s.isRoom && s.wantHidden && !s.denied ? 'hide' : 'none'
  if (s.isRoom) return s.roomHidden || !s.denied ? 'drop_record' : 'release'
  if (s.wantHidden) return s.denied ? 'none' : 'hide'
  return 'release'
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

/** A temporary auto room (static channels with a companion row are not). */
export function isTemporaryAutoRoom(id: string): boolean {
  return isAutoChannelVoice(id) && !isStaticChannel(id)
}

/** Why a watched id never counts as capacity, or null when it is eligible. */
export function watchIgnoreReason(id: string): 'temporary_room' | 'hub' | null {
  if (isTemporaryAutoRoom(id)) return 'temporary_room'
  if (isHubChannelCached(id)) return 'hub'
  return null
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

export interface WatchedSnapshot extends WatchedVcState {
  id: string
  name: string
}

/**
 * Resolve watched channels from the guild cache. Unresolvable ids, temporary
 * auto rooms and hubs are skipped (they never count as capacity).
 */
export function getWatchedSnapshot(guild: Guild): WatchedSnapshot[] {
  const out: WatchedSnapshot[] = []
  for (const id of getOverflowWatchIds()) {
    if (watchIgnoreReason(id)) continue
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

function hasViewDeny(guild: Guild, ch: VoiceBasedChannel): boolean {
  const ow = ch.permissionOverwrites.cache.get(guild.roles.everyone.id)
  return !!ow && ow.deny.has(PermissionFlagsBits.ViewChannel)
}

// ---------------------------------------------------------------------------
// Ownership record (voice.overflow_owned)
// ---------------------------------------------------------------------------

interface OwnedEntry {
  /** Decimal bigint of the bits the gate ADDED to the bot member overwrite. */
  botBits: string
  /** The bot member overwrite did not exist before the gate created it. */
  botCreated: boolean
  /**
   * Decimal bigint of the bits in botBits that the bot member overwrite
   * explicitly DENIED before the gate allowed them; restored on release.
   * Absent in older records (treated as '0').
   */
  botDenied?: string
  at: string
}

const DIGITS = /^\d+$/
const owned = new Map<string, OwnedEntry>()
let ownedLoaded = false
let ownedLoading: Promise<boolean> | null = null
// A persist failed; the next apply/sweep rewrites the record.
let ownedDirty = false
let persistChain: Promise<boolean> = Promise.resolve(true)

/** Parse the persisted record; null when unreadable. */
export function parseOwnedRecord(raw: string): Map<string, OwnedEntry> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out = new Map<string, OwnedEntry>()
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!DIGITS.test(id) || !v || typeof v !== 'object') continue
      const e = v as Partial<OwnedEntry>
      out.set(id, {
        botBits: typeof e.botBits === 'string' && DIGITS.test(e.botBits) ? e.botBits : '0',
        botCreated: e.botCreated === true,
        botDenied: typeof e.botDenied === 'string' && DIGITS.test(e.botDenied) ? e.botDenied : '0',
        at: typeof e.at === 'string' ? e.at : new Date().toISOString(),
      })
    }
    return out
  } catch {
    return null
  }
}

/**
 * Load the record once with a direct DB read (not the settings cache, which a
 * failed boot load leaves empty). Until a load succeeds the gate makes no
 * hide, release or persist; the next apply/sweep retries. Never throws.
 */
async function ensureOwnedLoaded(): Promise<boolean> {
  if (ownedLoaded) return true
  if (!ownedLoading) {
    ownedLoading = loadOwnedFromDb().finally(() => { ownedLoading = null })
  }
  return ownedLoading
}

async function loadOwnedFromDb(): Promise<boolean> {
  let rows: { key: string; value: string | null }[]
  try {
    rows = await db.select({ key: botSettings.key, value: botSettings.value }).from(botSettings)
      .where(inArray(botSettings.key, [OWNED_KEY, LEGACY_MARKER_KEY]))
  } catch (err) {
    logger.warn(`overflowGate: failed to load ${OWNED_KEY} — gate paused until it loads: ${(err as Error)?.message ?? err}`)
    return false
  }
  const raw = rows.find(r => r.key === OWNED_KEY)?.value ?? null
  owned.clear()
  if (raw) {
    const parsed = parseOwnedRecord(raw)
    if (parsed) for (const [id, e] of parsed) owned.set(id, e)
    else logger.warn(`overflowGate: ignoring unreadable ${OWNED_KEY}`)
  }
  ownedLoaded = true
  if (rows.some(r => r.key === LEGACY_MARKER_KEY)) {
    void clearSetting(LEGACY_MARKER_KEY)
      .then(() => logger.info(`overflowGate: removed legacy ${LEGACY_MARKER_KEY} (hubs it hid are not owned — clear them by hand)`))
      .catch(err => logger.warn(`overflowGate: failed to remove legacy ${LEGACY_MARKER_KEY}: ${err?.message ?? err}`))
  }
  return true
}

/**
 * Persist the whole map (serialized; latest state wins). Returns false on DB
 * error, and marks the record dirty so the next apply/sweep retries. Never
 * writes before the record has loaded (it would erase unloaded entries).
 */
function persistOwned(): Promise<boolean> {
  if (!ownedLoaded) return Promise.resolve(false)
  const run = persistChain.then(async () => {
    try {
      await setSetting(OWNED_KEY, JSON.stringify(Object.fromEntries(owned)), undefined, { audit: false })
      ownedDirty = false
      return true
    } catch (err) {
      ownedDirty = true
      logger.warn(`overflowGate: failed to persist ${OWNED_KEY} (will retry): ${(err as Error)?.message ?? err}`)
      return false
    }
  })
  persistChain = run
  return run
}

async function dropRecord(id: string): Promise<void> {
  if (owned.delete(id)) await persistOwned() // a failure sets ownedDirty; the sweep retries
}

/** auto_channels.isHidden for a room; null when the lookup failed. */
async function readRoomHidden(id: string): Promise<boolean | null> {
  try {
    const [row] = await db.select({ isHidden: autoChannels.isHidden }).from(autoChannels)
      .where(eq(autoChannels.voiceChannelId, id))
    return row?.isHidden ?? false
  } catch (err) {
    logger.warn(`overflowGate: failed to read room ${id}: ${(err as Error)?.message ?? err}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Locked per-channel steps (call only inside withChannelLock(id); never re-lock)
// ---------------------------------------------------------------------------

function wantHiddenNow(guild: Guild, id: string, requireListed: boolean): boolean {
  if (requireListed && !isHubChannelCached(id)) return false
  return isOverflowGateClosed(guild) && !isConvertingOrRoom(id)
}

/**
 * Clear the View deny if present, revert the bot bits the gate added (unless
 * `keepBotBits`), drop the record. `ch` must be fresh. False (record kept, the
 * sweep retries) on a failed write.
 */
async function releaseLocked(guild: Guild, ch: VoiceChannel, reason: string, keepBotBits: boolean): Promise<boolean> {
  const entry = owned.get(ch.id)
  if (!entry) return true
  if (hasViewDeny(guild, ch)) {
    try {
      await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: null }, { reason: 'overflow mode' })
      logger.info(`overflowGate(${reason}): revealed ${ch.id}`)
    } catch (err) {
      logger.warn(`overflowGate: failed to reveal ${ch.id}: ${(err as Error)?.message ?? err}`)
      return false
    }
  }
  const botId = guild.client.user!.id
  const me = ch.permissionOverwrites.cache.get(botId)
  const bits = BigInt(entry.botBits) & BOT_HUB_ALLOW
  // Bits the bot overwrite explicitly denied before the gate allowed them go
  // back to deny; the rest are cleared.
  const denied = BigInt(entry.botDenied ?? '0') & bits
  const restore = (bit: bigint): boolean | null => (denied & bit ? false : null)
  if (!keepBotBits && bits !== 0n && me) {
    try {
      if (entry.botCreated && denied === 0n && (me.allow.bitfield & ~bits) === 0n && me.deny.bitfield === 0n) {
        await ch.permissionOverwrites.delete(botId, 'overflow mode')
      } else {
        await ch.permissionOverwrites.edit(botId, {
          ...(bits & PermissionFlagsBits.ViewChannel ? { ViewChannel: restore(PermissionFlagsBits.ViewChannel) } : {}),
          ...(bits & PermissionFlagsBits.Connect ? { Connect: restore(PermissionFlagsBits.Connect) } : {}),
        }, { reason: 'overflow mode' })
      }
    } catch (err) {
      logger.warn(`overflowGate: failed to revert bot access on ${ch.id}: ${(err as Error)?.message ?? err}`)
      return false
    }
  }
  await dropRecord(ch.id)
  return true
}

/** Re-fetch, then release (used to roll a hide back). */
async function rollbackLocked(guild: Guild, id: string, reason: string): Promise<void> {
  const fresh = await fetchFreshVoice(guild, id)
  if (fresh.kind === 'missing') { await dropRecord(id); return }
  if (fresh.kind === 'failed') return // record kept; the sweep releases it
  await releaseLocked(guild, fresh.ch, reason, false)
}

/**
 * Record ownership (map + DB) BEFORE writing anything, grant the bot the bits
 * it lacks, re-check the gate, then deny @everyone View. Any failure or a gate
 * that opened meanwhile rolls back (fail open). `ch` must be fresh.
 */
async function hideLocked(guild: Guild, ch: VoiceChannel, reason: string, requireListed: boolean): Promise<void> {
  const id = ch.id
  const botId = guild.client.user!.id
  const me = ch.permissionOverwrites.cache.get(botId)
  const missing = BOT_HUB_ALLOW & ~(me?.allow.bitfield ?? 0n)
  const prev = owned.get(id)
  owned.set(id, {
    botBits: ((prev ? BigInt(prev.botBits) : 0n) | missing).toString(),
    botCreated: (prev?.botCreated ?? false) || !me,
    botDenied: ((prev ? BigInt(prev.botDenied ?? '0') : 0n) | (missing & (me?.deny.bitfield ?? 0n))).toString(),
    at: prev?.at ?? new Date().toISOString(),
  })
  if (!(await persistOwned())) {
    if (prev) owned.set(id, prev); else owned.delete(id)
    return
  }
  // The bot must keep seeing/managing the hub once @everyone is denied.
  if (missing !== 0n) {
    try {
      await ch.permissionOverwrites.edit(botId, {
        ...(missing & PermissionFlagsBits.ViewChannel ? { ViewChannel: true } : {}),
        ...(missing & PermissionFlagsBits.Connect ? { Connect: true } : {}),
      }, { reason: 'overflow mode' })
    } catch (err) {
      logger.warn(`overflowGate: failed to grant bot access on hub ${id}: ${(err as Error)?.message ?? err}`)
      await rollbackLocked(guild, id, reason)
      return
    }
  }
  // The awaits above can overlap a flag-off, a gate opening or a hub join.
  if (!wantHiddenNow(guild, id, requireListed)) {
    await rollbackLocked(guild, id, reason)
    return
  }
  try {
    await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false }, { reason: 'overflow mode' })
    logger.info(`overflowGate(${reason}): hid hub ${id}`)
  } catch (err) {
    logger.warn(`overflowGate: failed to hide hub ${id}: ${(err as Error)?.message ?? err}`)
    // The PUT may have landed anyway: keep the record only if the deny is there.
    const again = await fetchFreshVoice(guild, id)
    if (again.kind === 'ok' && hasViewDeny(guild, again.ch)) return
    if (again.kind === 'failed') return // record kept; the sweep reconciles
    if (again.kind === 'missing') { await dropRecord(id); return }
    await releaseLocked(guild, again.ch, reason, false)
  }
}

/** Fresh-fetch one channel and bring it in line with decideHubAction. Never throws. */
async function reconcileLocked(guild: Guild, id: string, reason: string, requireListed: boolean): Promise<void> {
  try {
    const fresh = await fetchFreshVoice(guild, id)
    if (fresh.kind === 'failed') {
      logger.warn(`overflowGate(${reason}): failed to fetch ${id}: ${(fresh.error as Error)?.message ?? fresh.error}`)
      return
    }
    if (fresh.kind === 'missing') {
      if (owned.has(id)) logger.info(`overflowGate(${reason}): ${id} no longer exists — dropping record`)
      await dropRecord(id)
      return
    }
    const ch = fresh.ch
    const isOwned = owned.has(id)
    const isRoom = isConvertingOrRoom(id) && !isStaticChannel(id)
    let roomHidden = false
    if (isRoom && isOwned && isAutoChannelVoice(id)) {
      const hidden = await readRoomHidden(id)
      if (hidden === null) return // record kept; retried later
      roomHidden = hidden
    }
    const action = decideHubAction({
      wantHidden: wantHiddenNow(guild, id, requireListed),
      owned: isOwned,
      denied: hasViewDeny(guild, ch),
      isRoom,
      roomHidden,
    })
    if (action === 'hide') await hideLocked(guild, ch, reason, requireListed)
    // Rooms keep the bot's View+Connect allow (harmless; saves a PUT on join).
    else if (action === 'release') await releaseLocked(guild, ch, reason, isRoom)
    else if (action === 'drop_record') await dropRecord(id)
  } catch (err) {
    logger.warn(`overflowGate(${reason}): reconcile ${id} failed: ${(err as Error)?.message ?? err}`)
  }
}

// ---------------------------------------------------------------------------
// Hub lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * Called on a freshly created replacement hub, before it is registered as a
 * hub: hide it when the gate is closed. The ownership record lands before the
 * deny, so a concurrent disable (which iterates the record, not listHubs())
 * always cleans it up. Any failure leaves it visible. Never throws.
 */
export async function hideNewHubIfGateClosed(guild: Guild, ch: VoiceBasedChannel): Promise<void> {
  try {
    if (!(await ensureOwnedLoaded())) return // fail open; the sweep retries
    if (!isOverflowGateClosed(guild)) return
    await withChannelLock(ch.id, () => reconcileLocked(guild, ch.id, 'new_hub', false))
  } catch (err) {
    logger.warn(`overflowGate: failed to hide new hub ${ch.id}: ${(err as Error)?.message ?? err}`)
  }
}

/**
 * H3 — called right before a hub is renamed into a room: remove the gate's
 * deny so the new room is visible (record.isHidden is false). Only a deny the
 * gate owns is removed; an admin-hidden hub stays as set. Never throws.
 */
export async function clearOverflowHideForConversion(guild: Guild, hub: VoiceBasedChannel): Promise<void> {
  markHubConverting(hub.id)
  // Not loaded: ownership unknown, so write nothing; once loaded the sweep
  // releases an owned deny left on the room.
  if (!(await ensureOwnedLoaded())) return
  if (!owned.has(hub.id)) return
  await withChannelLock(hub.id, () => reconcileLocked(guild, hub.id, 'conversion', true))
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
 * Reconcile every listed hub and every owned channel with the gate state.
 * Flag off with an empty record: zero REST calls. Otherwise only channels whose
 * cached state disagrees are fetched and written (under the channel lock).
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
  if (!(await ensureOwnedLoaded())) return // paused until the record loads
  if (ownedDirty) await persistOwned()
  const enabled = isOverflowEnabled()
  if (!enabled && owned.size === 0) return

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

  const hubIds = enabled ? listHubs().map(h => h.channelId) : []
  const hubSet = new Set(hubIds)
  for (const id of new Set([...hubIds, ...owned.keys()])) {
    const isOwned = owned.has(id)
    if (isConvertingOrRoom(id) && !isOwned) continue
    const wantHidden = hide && hubSet.has(id) && !isConvertingOrRoom(id)
    // Cache hints (the locked step re-checks against fresh state).
    const cached = guild.channels.cache.get(id)
    const cachedDeny = !!cached?.isVoiceBased() && hasViewDeny(guild, cached)
    if (!wantHidden && !isOwned) continue
    if (wantHidden && cachedDeny) continue // owned and hidden, or an admin restriction
    await withChannelLock(id, () => reconcileLocked(guild, id, reason, true))
  }
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
