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
  await db.insert(botSettings)
    .values({ key, value, updatedByDiscordId: byDiscordId ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: botSettings.key,
      set: { value, updatedByDiscordId: byDiscordId ?? null, updatedAt: new Date() },
    })
  settingsCache.set(key, value)
}

export async function clearSetting(key: string): Promise<void> {
  await db.delete(botSettings).where(eq(botSettings.key, key))
  settingsCache.delete(key)
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
  await db.insert(sudoUsers)
    .values({ userId, addedByDiscordId: byDiscordId ?? null, note: note ?? null })
    .onConflictDoNothing()
  sudoUsersCache.add(userId)
}

export async function removeSudoUser(userId: string): Promise<void> {
  await db.delete(sudoUsers).where(eq(sudoUsers.userId, userId))
  sudoUsersCache.delete(userId)
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
  })
}

export async function unregisterHubChannel(channelId: string): Promise<void> {
  await db.delete(hubChannels).where(eq(hubChannels.channelId, channelId))
  hubsCache.delete(channelId)
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
