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

export async function loadSettings(): Promise<void> {
  settingsCache.clear()
  sudoUsersCache.clear()
  autoThreadCache.clear()
  hubsCache.clear()
  autoChannelTextIdsCache.clear()
  autoChannelVoiceMapCache.clear()
  const [rows, sudo, threads, hubs, autos] = await Promise.all([
    db.select().from(botSettings).catch(() => []),
    db.select().from(sudoUsers).catch(() => []),
    db.select().from(autoThreadChannels).catch(() => []),
    db.select().from(hubChannels).catch(() => []),
    db.select({ voiceChannelId: autoChannels.voiceChannelId, textChannelId: autoChannels.textChannelId }).from(autoChannels).catch(() => []),
  ])
  for (const r of rows) settingsCache.set(r.key, r.value)
  for (const s of sudo) sudoUsersCache.add(s.userId)
  for (const t of threads) {
    autoThreadCache.set(t.channelId, {
      channelId: t.channelId,
      guildId: t.guildId,
      nameTemplate: t.nameTemplate,
      archiveDuration: t.archiveDuration,
    })
  }
  for (const h of hubs) {
    hubsCache.set(h.channelId, {
      id: h.id,
      channelId: h.channelId,
      guildId: h.guildId,
      categoryId: h.categoryId,
      position: h.position,
      label: h.label,
      defaultTemplateKey: h.defaultTemplateKey,
      defaultManualName: h.defaultManualName,
      defaultUserLimit: h.defaultUserLimit,
    })
  }
  for (const a of autos) {
    autoChannelTextIdsCache.add(a.textChannelId)
    autoChannelVoiceMapCache.set(a.voiceChannelId, a.textChannelId)
  }
}

// ---------------------------------------------------------------------------
// Generic key/value settings
// ---------------------------------------------------------------------------

export function getSetting(key: string): string | null {
  return settingsCache.get(key) ?? null
}

export async function setSetting(key: string, value: string, byDiscordId?: string): Promise<void> {
  const oldValue = settingsCache.get(key) ?? null
  await db.insert(botSettings)
    .values({ key, value, updatedByDiscordId: byDiscordId ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: botSettings.key,
      set: { value, updatedByDiscordId: byDiscordId ?? null, updatedAt: new Date() },
    })
  settingsCache.set(key, value)
  // Audit log (#31) — only when the value actually changed, to avoid noise.
  if (oldValue !== value) {
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
}

export async function removeAutoThreadChannel(channelId: string): Promise<void> {
  await db.delete(autoThreadChannels).where(eq(autoThreadChannels.channelId, channelId))
  autoThreadCache.delete(channelId)
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
  hubsCache.set(final.channelId, {
    id: final.id,
    channelId: final.channelId,
    guildId: final.guildId,
    categoryId: final.categoryId,
    position: final.position,
    label: final.label,
    defaultTemplateKey: final.defaultTemplateKey,
    defaultManualName: final.defaultManualName,
    defaultUserLimit: final.defaultUserLimit,
  })
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
  }
}

export async function unregisterHubChannel(channelId: string): Promise<void> {
  await db.delete(hubChannels).where(eq(hubChannels.channelId, channelId))
  hubsCache.delete(channelId)
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
  const hubs = await db.select().from(hubChannels)
  hubsCache.clear()
  for (const h of hubs) {
    hubsCache.set(h.channelId, {
      id: h.id,
      channelId: h.channelId,
      guildId: h.guildId,
      categoryId: h.categoryId,
      position: h.position,
      label: h.label,
      defaultTemplateKey: h.defaultTemplateKey,
      defaultManualName: h.defaultManualName,
      defaultUserLimit: h.defaultUserLimit,
    })
  }
  return hubs.length
}

/** Update the cached hub's tracked channelId after the reconciler creates a replacement. */
export function updateHubChannelId(oldChannelId: string, newChannelId: string): void {
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
}

export function untrackAutoChannelText(textChannelId: string): void {
  autoChannelTextIdsCache.delete(textChannelId)
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

export function trackAutoChannelVoice(voiceChannelId: string, textChannelId: string): void {
  autoChannelVoiceMapCache.set(voiceChannelId, textChannelId)
}

export function untrackAutoChannelVoice(voiceChannelId: string): void {
  autoChannelVoiceMapCache.delete(voiceChannelId)
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
