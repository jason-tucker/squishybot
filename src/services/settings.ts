/**
 * Runtime-overridable settings backed by the `bot_settings` and `sudo_users`
 * tables. Both are loaded into in-memory caches at startup so reads stay
 * synchronous. Writes hit the DB and update the cache.
 *
 * Key naming convention: lowercase snake/dot keys (e.g. `voice.cleanup_delay_ms`,
 * `channel.log`, `channel.clips`, `feature.clips_auto_thread`).
 */
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { autoChannels, autoThreadChannels, botSettings, hubChannels, sudoUsers } from '../db/schema'
import {
  publish,
  settingsCh,
  sudoCh,
  type SettingChangedEvent,
  type SudoGrantedEvent,
  type SudoRevokedEvent,
} from './eventBus'
import {
  createReloadTracker,
  mergeMapSnapshot,
  mergeSetSnapshot,
  touchTrackers,
  type CacheKind,
  type ReloadTracker,
} from './cacheMerge'

// ---------------------------------------------------------------------------
// In-memory caches
// ---------------------------------------------------------------------------

const settingsCache = new Map<string, string>()
const sudoUsersCache = new Set<string>()

export interface AutoThreadConfig {
  channelId: string
  guildId: string
  nameTemplate: string | null
  archiveDuration: number | null
}
const autoThreadCache = new Map<string, AutoThreadConfig>()

export interface HubInfo {
  id: string
  channelId: string
  guildId: string
  categoryId: string
  position: number
  label: string
  defaultTemplateKey: string | null
  defaultManualName: string | null
  defaultUserLimit: number | null
}
const hubsCache = new Map<string, HubInfo>()  // keyed by channelId

// Set of text-channel IDs belonging to live auto channels.
// Read on the messageCreate hot path to avoid a DB query per message.
const autoChannelTextIdsCache = new Set<string>()

// Map of auto-channel voice IDs → their attached text channel ID.
// Read on messageCreate for the "no voice-chat messages" PSA feature so we
// can both identify the voice channel and link the user to the proper chat.
const autoChannelVoiceMapCache = new Map<string, string>()

// ---------------------------------------------------------------------------
// Reload tracking. A reload reads the DB, then swaps the result in. Any cache
// mutation that lands while its queries are in flight would be reverted by a
// plain clear+rebuild (the snapshot may predate it). So each reload registers
// a tracker before querying, every mutator calls touch() after changing the
// live cache, and the swap keeps the live state for touched keys.
// ---------------------------------------------------------------------------

const activeReloads = new Set<ReloadTracker>()

function touch(kind: CacheKind, key: string): void {
  touchTrackers(activeReloads, kind, key)
}

function toHubInfo(h: typeof hubChannels.$inferSelect): HubInfo {
  return {
    id: h.id,
    channelId: h.channelId,
    guildId: h.guildId,
    categoryId: h.categoryId,
    position: h.position,
    label: h.label,
    defaultTemplateKey: h.defaultTemplateKey,
    defaultManualName: h.defaultManualName,
    defaultUserLimit: h.defaultUserLimit,
  }
}

export async function loadSettings(): Promise<void> {
  // Read everything BEFORE touching the live caches. The swap below is fully
  // synchronous, so concurrent event handlers (voiceStateUpdate, messageCreate,
  // sudo checks, …) never observe a half-cleared cache while the queries are
  // in flight — this matters because the cache invalidator re-runs this on
  // every panel-side settings edit, not just at boot. It also means a failed
  // query aborts the reload with the previous state intact instead of wiping
  // in-memory config until the next successful reload (the old per-query
  // `.catch(() => [])` silently blanked whichever cache had failed). Callers
  // are expected to catch and log the rejection.
  const tracker = createReloadTracker()
  activeReloads.add(tracker)
  try {
    const [rows, sudo, threads, hubs, autos] = await Promise.all([
      db.select().from(botSettings),
      db.select().from(sudoUsers),
      db.select().from(autoThreadChannels),
      db.select().from(hubChannels),
      db.select({ voiceChannelId: autoChannels.voiceChannelId, textChannelId: autoChannels.textChannelId }).from(autoChannels),
    ])
    const snapSettings = new Map<string, string>()
    for (const r of rows) snapSettings.set(r.key, r.value)
    const snapSudo = new Set<string>()
    for (const u of sudo) snapSudo.add(u.userId)
    const snapThreads = new Map<string, AutoThreadConfig>()
    for (const t of threads) {
      snapThreads.set(t.channelId, {
        channelId: t.channelId,
        guildId: t.guildId,
        nameTemplate: t.nameTemplate,
        archiveDuration: t.archiveDuration,
      })
    }
    const snapHubs = new Map<string, HubInfo>()
    for (const h of hubs) snapHubs.set(h.channelId, toHubInfo(h))
    const snapText = new Set<string>()
    const snapVoice = new Map<string, string>()
    for (const a of autos) {
      snapText.add(a.textChannelId)
      snapVoice.set(a.voiceChannelId, a.textChannelId)
    }
    // Synchronous swap: the snapshot, except keys mutated during the queries.
    mergeMapSnapshot(settingsCache, snapSettings, tracker.settings)
    mergeSetSnapshot(sudoUsersCache, snapSudo, tracker.sudo)
    mergeMapSnapshot(autoThreadCache, snapThreads, tracker.threads)
    mergeMapSnapshot(hubsCache, snapHubs, tracker.hubs)
    mergeSetSnapshot(autoChannelTextIdsCache, snapText, tracker.autoText)
    mergeMapSnapshot(autoChannelVoiceMapCache, snapVoice, tracker.autoVoice)
  } finally {
    activeReloads.delete(tracker)
  }
}

// ---------------------------------------------------------------------------
// Generic key/value settings
// ---------------------------------------------------------------------------

export function getSetting(key: string): string | null {
  return settingsCache.get(key) ?? null
}

/**
 * Persist a setting. `opts.audit` (default true) controls whether a changed
 * value also lands in `setting_changes` and fans out a `setting_changed`
 * event. Internal bookkeeping keys that churn on a timer (e.g.
 * `presence.last_used_at`, rewritten every few minutes for as long as the
 * bot is in use) pass `audit: false` so they don't grow the audit table and
 * spam the event bus forever; operator-facing settings should never disable it.
 */
export async function setSetting(
  key: string,
  value: string,
  byDiscordId?: string,
  opts?: { audit?: boolean },
): Promise<void> {
  const oldValue = settingsCache.get(key) ?? null
  await db.insert(botSettings)
    .values({ key, value, updatedByDiscordId: byDiscordId ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: botSettings.key,
      set: { value, updatedByDiscordId: byDiscordId ?? null, updatedAt: new Date() },
    })
  settingsCache.set(key, value)
  touch('settings', key)
  // Audit log (#31) — only when the value actually changed, to avoid noise.
  if (oldValue !== value && opts?.audit !== false) {
    const { settingChanges } = await import('../db/schema')
    await db.insert(settingChanges).values({ key, oldValue, newValue: value, changedByUserId: byDiscordId ?? null }).catch(() => {})
    void publish<SettingChangedEvent>(settingsCh('setting_changed'), {
      key, oldValue, newValue: value, by: byDiscordId ?? null, ts: new Date().toISOString(),
    })
  }
}

export async function clearSetting(key: string, byDiscordId?: string): Promise<void> {
  const oldValue = settingsCache.get(key) ?? null
  await db.delete(botSettings).where(eq(botSettings.key, key))
  settingsCache.delete(key)
  touch('settings', key)
  if (oldValue !== null) {
    const { settingChanges } = await import('../db/schema')
    await db.insert(settingChanges).values({ key, oldValue, newValue: null, changedByUserId: byDiscordId ?? null }).catch(() => {})
    void publish<SettingChangedEvent>(settingsCh('setting_changed'), {
      key, oldValue, newValue: null, by: byDiscordId ?? null, ts: new Date().toISOString(),
    })
  }
}

export function listSettings(): { key: string; value: string }[] {
  return Array.from(settingsCache.entries()).map(([key, value]) => ({ key, value }))
}

// ---------------------------------------------------------------------------
// Setting + env fallback (used by call sites that previously only read env)
// ---------------------------------------------------------------------------

export function settingOr<T>(key: string, fallback: T): string | T {
  const v = settingsCache.get(key)
  return v !== undefined ? v : fallback
}

export function settingOrNumber(key: string, fallback: number): number {
  const v = settingsCache.get(key)
  if (v === undefined) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// ---------------------------------------------------------------------------
// Sudo users — DB-backed additions to env SUDO_USER_IDS
// ---------------------------------------------------------------------------

export function isAdditionalSudo(userId: string): boolean {
  return sudoUsersCache.has(userId)
}

export function listAdditionalSudoUsers(): string[] {
  return Array.from(sudoUsersCache)
}

export async function addSudoUser(userId: string, byDiscordId?: string, note?: string): Promise<void> {
  const wasAlreadySudo = sudoUsersCache.has(userId)
  await db.insert(sudoUsers)
    .values({ userId, addedByDiscordId: byDiscordId ?? null, note: note ?? null })
    .onConflictDoNothing()
  sudoUsersCache.add(userId)
  touch('sudo', userId)
  if (!wasAlreadySudo) {
    void publish<SudoGrantedEvent>(sudoCh('granted'), {
      userId, by: byDiscordId ?? null, ts: new Date().toISOString(),
    })
  }
}

export async function removeSudoUser(userId: string, byDiscordId?: string): Promise<void> {
  const hadSudo = sudoUsersCache.has(userId)
  await db.delete(sudoUsers).where(eq(sudoUsers.userId, userId))
  sudoUsersCache.delete(userId)
  touch('sudo', userId)
  if (hadSudo) {
    void publish<SudoRevokedEvent>(sudoCh('revoked'), {
      userId, by: byDiscordId ?? null, ts: new Date().toISOString(),
    })
  }
}

// ---------------------------------------------------------------------------
// Auto-thread channels — message in any of these channels gets a thread
// ---------------------------------------------------------------------------

export function isAutoThreadChannel(channelId: string): boolean {
  return autoThreadCache.has(channelId)
}

export function getAutoThreadConfig(channelId: string): AutoThreadConfig | null {
  return autoThreadCache.get(channelId) ?? null
}

export function listAutoThreadChannels(): AutoThreadConfig[] {
  return Array.from(autoThreadCache.values())
}

export async function addAutoThreadChannel(
  channelId: string,
  guildId: string,
  byDiscordId?: string,
  options?: { nameTemplate?: string | null; archiveDuration?: number | null }
): Promise<void> {
  const cfg: AutoThreadConfig = {
    channelId,
    guildId,
    nameTemplate: options?.nameTemplate ?? null,
    archiveDuration: options?.archiveDuration ?? null,
  }
  await db.insert(autoThreadChannels)
    .values({
      channelId,
      guildId,
      nameTemplate: cfg.nameTemplate,
      archiveDuration: cfg.archiveDuration,
      addedByDiscordId: byDiscordId ?? null,
    })
    .onConflictDoUpdate({
      target: autoThreadChannels.channelId,
      set: {
        guildId,
        nameTemplate: cfg.nameTemplate,
        archiveDuration: cfg.archiveDuration,
        addedByDiscordId: byDiscordId ?? null,
      },
    })
  autoThreadCache.set(channelId, cfg)
  touch('threads', channelId)
}

export async function updateAutoThreadChannel(
  channelId: string,
  patch: { nameTemplate?: string | null; archiveDuration?: number | null },
): Promise<void> {
  const existing = autoThreadCache.get(channelId)
  if (!existing) return
  const next: AutoThreadConfig = {
    ...existing,
    nameTemplate: patch.nameTemplate !== undefined ? patch.nameTemplate : existing.nameTemplate,
    archiveDuration: patch.archiveDuration !== undefined ? patch.archiveDuration : existing.archiveDuration,
  }
  await db.update(autoThreadChannels)
    .set({ nameTemplate: next.nameTemplate, archiveDuration: next.archiveDuration })
    .where(eq(autoThreadChannels.channelId, channelId))
  autoThreadCache.set(channelId, next)
  touch('threads', channelId)
}

export async function removeAutoThreadChannel(channelId: string): Promise<void> {
  await db.delete(autoThreadChannels).where(eq(autoThreadChannels.channelId, channelId))
  autoThreadCache.delete(channelId)
  touch('threads', channelId)
}

// ---------------------------------------------------------------------------
// Hub channels
// ---------------------------------------------------------------------------

export function isHubChannelCached(channelId: string): boolean {
  return hubsCache.has(channelId)
}

export function getHubInfo(channelId: string): HubInfo | null {
  return hubsCache.get(channelId) ?? null
}

export function listHubs(): HubInfo[] {
  return Array.from(hubsCache.values())
}

export async function registerHubChannel(input: {
  channelId: string
  guildId: string
  categoryId: string
  position: number
  label: string
}): Promise<void> {
  const [row] = await db.insert(hubChannels)
    .values({
      channelId: input.channelId,
      guildId: input.guildId,
      categoryId: input.categoryId,
      position: input.position,
      label: input.label,
    })
    .onConflictDoNothing({ target: hubChannels.channelId })
    .returning()

  // If we hit the conflict, fetch the existing row instead.
  const final = row ?? (await db.select().from(hubChannels).where(eq(hubChannels.channelId, input.channelId)))[0]
  if (!final) return
  hubsCache.set(final.channelId, toHubInfo(final))
  touch('hubs', final.channelId)
}

/**
 * Update the per-hub auto-channel defaults. Pass null for any field to clear
 * that override (bot falls back to built-in defaults).
 */
export async function setHubDefaults(
  channelId: string,
  defaults: { templateKey: string | null; manualName: string | null; userLimit: number | null },
): Promise<void> {
  await db.update(hubChannels)
    .set({
      defaultTemplateKey: defaults.templateKey,
      defaultManualName: defaults.manualName,
      defaultUserLimit: defaults.userLimit,
    })
    .where(eq(hubChannels.channelId, channelId))
  const cached = hubsCache.get(channelId)
  if (cached) {
    hubsCache.set(channelId, {
      ...cached,
      defaultTemplateKey: defaults.templateKey,
      defaultManualName: defaults.manualName,
      defaultUserLimit: defaults.userLimit,
    })
    touch('hubs', channelId)
  }
}

export async function unregisterHubChannel(channelId: string): Promise<void> {
  await db.delete(hubChannels).where(eq(hubChannels.channelId, channelId))
  hubsCache.delete(channelId)
  touch('hubs', channelId)
}

/**
 * Re-read every `hub_channels` row from the DB and rebuild the in-memory
 * `hubsCache`. Used by the `hub.refresh_cache` RPC verb so panel-side
 * DB-only CRUD takes effect immediately without redeploying.
 *
 * Unlike `loadSettings()` this only touches the hubs cache — settings,
 * sudo users, auto threads, etc. stay put so we don't accidentally clear
 * other state on a hub-only refresh.
 *
 * Returns the new hub count so callers can confirm what landed.
 */
export async function reloadHubsCache(): Promise<number> {
  const tracker = createReloadTracker()
  activeReloads.add(tracker)
  try {
    const hubs = await db.select().from(hubChannels)
    const snapHubs = new Map<string, HubInfo>()
    for (const h of hubs) snapHubs.set(h.channelId, toHubInfo(h))
    mergeMapSnapshot(hubsCache, snapHubs, tracker.hubs)
    return hubs.length
  } finally {
    activeReloads.delete(tracker)
  }
}

/**
 * Update the cached hub's tracked channelId after a replacement hub is
 * created. Callers run it before the hub_channels UPDATE (so a join on the
 * new hub is recognized at once) and again after it commits: idempotent, and
 * the second call repairs a reload that read the old row before the commit.
 * Both ids are touched even on the no-op path so an in-flight reload keeps
 * the live state for them.
 */
export function updateHubChannelId(oldChannelId: string, newChannelId: string): void {
  touch('hubs', oldChannelId)
  touch('hubs', newChannelId)
  const hub = hubsCache.get(oldChannelId)
  if (!hub) return
  hubsCache.delete(oldChannelId)
  hubsCache.set(newChannelId, { ...hub, channelId: newChannelId })
}

// ---------------------------------------------------------------------------
// Auto-channel text-channel IDs — hot-path lookup for messageCreate
// ---------------------------------------------------------------------------

export function isAutoChannelText(textChannelId: string): boolean {
  return autoChannelTextIdsCache.has(textChannelId)
}

export function trackAutoChannelText(textChannelId: string): void {
  autoChannelTextIdsCache.add(textChannelId)
  touch('autoText', textChannelId)
}

export function untrackAutoChannelText(textChannelId: string): void {
  autoChannelTextIdsCache.delete(textChannelId)
  touch('autoText', textChannelId)
}

// ---------------------------------------------------------------------------
// Auto-channel voice-channel IDs — hot-path lookup for the "no voice-chat
// messages" PSA on messages in the built-in voice-channel text chat.
// ---------------------------------------------------------------------------

export function isAutoChannelVoice(voiceChannelId: string): boolean {
  return autoChannelVoiceMapCache.has(voiceChannelId)
}

export function getAutoChannelTextFor(voiceChannelId: string): string | null {
  return autoChannelVoiceMapCache.get(voiceChannelId) ?? null
}

/**
 * All tracked auto-channel voice IDs. Kept in lockstep with `auto_channels`
 * by the create/delete lifecycle hooks + `loadSettings()`, so callers that
 * only need the ID set (e.g. hub-join name-collision checks) can skip a
 * full-table query.
 */
export function listAutoChannelVoiceIds(): string[] {
  return Array.from(autoChannelVoiceMapCache.keys())
}

export function trackAutoChannelVoice(voiceChannelId: string, textChannelId: string): void {
  autoChannelVoiceMapCache.set(voiceChannelId, textChannelId)
  touch('autoVoice', voiceChannelId)
}

export function untrackAutoChannelVoice(voiceChannelId: string): void {
  autoChannelVoiceMapCache.delete(voiceChannelId)
  touch('autoVoice', voiceChannelId)
}

// ---------------------------------------------------------------------------
// Boolean setting helper. Stored as the string "true" / "false" in
// bot_settings; default is whatever the caller wants (usually false).
// ---------------------------------------------------------------------------

export function getBoolSetting(key: string, fallback = false): boolean {
  const v = settingsCache.get(key)
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}
