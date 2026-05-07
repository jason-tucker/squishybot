/**
 * User profile CRUD. Profiles are upserted on first interaction and edited
 * via /sudo → Settings → User Profiles, the Manage User context menu (sudo),
 * or /profile (self-service, limited fields).
 *
 * No in-memory cache — profiles are read on demand. The hot path is the
 * birthday scheduler, which queries by (guild, month, day) once per day.
 */
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { userProfiles } from '../db/schema'
import { logger } from './logger'

export type UserProfile = typeof userProfiles.$inferSelect

export type SudoEditableField =
  | 'realName' | 'displayName'
  | 'birthdayMonth' | 'birthdayDay' | 'birthdayYear'
  | 'birthdayPingsEnabled' | 'birthdayYearVisible'
  | 'staffCategory' | 'department' | 'tier' | 'leadershipTitle'

export type SelfEditableField =
  | 'displayName'
  | 'birthdayMonth' | 'birthdayDay' | 'birthdayYear'
  | 'birthdayPingsEnabled' | 'birthdayYearVisible'

const SELF_EDITABLE: ReadonlyArray<SelfEditableField> = [
  'displayName', 'birthdayMonth', 'birthdayDay', 'birthdayYear',
  'birthdayPingsEnabled', 'birthdayYearVisible',
]

export function isSelfEditable(field: string): field is SelfEditableField {
  return (SELF_EDITABLE as readonly string[]).includes(field)
}

export async function getProfile(guildId: string, userId: string): Promise<UserProfile | null> {
  const [row] = await db.select().from(userProfiles)
    .where(and(eq(userProfiles.guildId, guildId), eq(userProfiles.userId, userId)))
  return row ?? null
}

/** Get the profile, creating an empty row if none exists yet. */
export async function ensureProfile(guildId: string, userId: string): Promise<UserProfile> {
  const existing = await getProfile(guildId, userId)
  if (existing) return existing
  const [created] = await db.insert(userProfiles)
    .values({ guildId, userId })
    .returning()
  return created
}

/**
 * Apply a partial update to a profile, auto-creating the row if absent.
 * `editor` is the Discord ID of whoever made the change (for audit logs).
 * `mode` distinguishes sudo edits (full field set) from self-service.
 */
export async function updateProfile(
  guildId: string,
  userId: string,
  patch: Partial<Pick<UserProfile, SudoEditableField>>,
  editor: { editorDiscordId: string; mode: 'sudo' | 'self' }
): Promise<UserProfile> {
  if (editor.mode === 'self') {
    for (const k of Object.keys(patch)) {
      if (!isSelfEditable(k)) {
        throw new Error(`Field "${k}" is not self-editable`)
      }
    }
  }
  await ensureProfile(guildId, userId)
  const [updated] = await db.update(userProfiles)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(userProfiles.guildId, guildId), eq(userProfiles.userId, userId)))
    .returning()

  const fields = Object.keys(patch).join(', ') || '(no-op)'
  logger.info(`profile-edit by=${editor.editorDiscordId} target=${userId} mode=${editor.mode} fields=${fields}`)

  return updated
}

export async function countProfiles(guildId: string): Promise<number> {
  const [{ value }] = await db.select({ value: sql<number>`count(*)::int` }).from(userProfiles)
    .where(eq(userProfiles.guildId, guildId))
  return value
}

export async function countProfilesWithBirthday(guildId: string): Promise<number> {
  const [{ value }] = await db.select({ value: sql<number>`count(*)::int` }).from(userProfiles)
    .where(and(
      eq(userProfiles.guildId, guildId),
      sql`${userProfiles.birthdayMonth} IS NOT NULL`,
      sql`${userProfiles.birthdayDay} IS NOT NULL`,
    ))
  return value
}

/** Used by the birthday scheduler. */
export async function findBirthdayUsers(guildId: string, month: number, day: number): Promise<UserProfile[]> {
  return db.select().from(userProfiles).where(and(
    eq(userProfiles.guildId, guildId),
    eq(userProfiles.birthdayMonth, month),
    eq(userProfiles.birthdayDay, day),
    eq(userProfiles.birthdayPingsEnabled, true),
  ))
}

/** Light-weight format helper used by sudo + self panels. */
export function formatBirthday(p: UserProfile | null): string {
  if (!p?.birthdayMonth || !p?.birthdayDay) return '_unset_'
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const md = `${months[p.birthdayMonth - 1]} ${p.birthdayDay}`
  if (p.birthdayYear && p.birthdayYearVisible) return `${md}, ${p.birthdayYear}`
  return md
}
