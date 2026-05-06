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
import { botSettings, sudoUsers, autoThreadChannels } from '../db/schema'

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

export async function loadSettings(): Promise<void> {
  settingsCache.clear()
  sudoUsersCache.clear()
  autoThreadCache.clear()
  const [rows, sudo, threads] = await Promise.all([
    db.select().from(botSettings).catch(() => []),
    db.select().from(sudoUsers).catch(() => []),
    db.select().from(autoThreadChannels).catch(() => []),
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
