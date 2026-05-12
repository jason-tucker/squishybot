/**
 * `staff.grant` — RPC verb that grants one of the 7 staff roles to a Discord
 * member. Mirrors the in-bot approval flow (`interactions/buttons/staffApproval.ts`)
 * but driven by the panel command bus so /sudo can approve a queued request or
 * direct-grant on its own.
 *
 * Params: `{ userId: string, roleKey: string }`
 *   - `userId` is a Discord snowflake.
 *   - `roleKey` is the `bot_settings` key — e.g. `staff.role.tier_1` — that
 *     holds the linked Discord role ID. We also accept the bare slug
 *     (`tier_1`) and normalize to the full key, so panel-side selects can
 *     post the shorter token without having to know about the registry's
 *     storage convention.
 *
 * Reply:
 *   - `{ ok: true, data: { roleId, roleName } }` on success (also on
 *     "already-had-role" — idempotent grants are a feature, not a bug, and
 *     the panel doesn't need to distinguish).
 *   - `{ ok: false, error, details? }` on user-not-found, role-missing,
 *     role-not-linked, member-fetch failure, or Discord API error. `error`
 *     is a stable machine token (`user-not-found`, `role-key-unknown`,
 *     `role-not-linked`, `role-missing-in-guild`, `member-fetch-failed`,
 *     `discord-error`); `details` carries the human/Discord message so the
 *     /sudo card can render it.
 *
 * Side-effects: logs every success at info, every failure at warn so an
 * operator pulling container logs has a paper trail next to the audit row
 * the panel writes.
 */
import { registerVerb, type VerbHandler } from '../../registry'
import { env } from '../../../../config/env'
import { logger } from '../../../logger'
import { getSetting } from '../../../settings'
import { findStaffRoleDefByKey, findStaffRoleDefBySlug } from '../../../staffRoles'

type GrantParams = {
  userId: string
  roleKey: string
}

function isGrantParams(v: unknown): v is GrantParams {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return typeof p.userId === 'string' && p.userId.length > 0
      && typeof p.roleKey === 'string' && p.roleKey.length > 0
}

/**
 * Normalize a caller-supplied role token into the canonical `bot_settings`
 * key. Accepts either the full key (`staff.role.tier_1`) or the bare slug
 * (`tier_1`) — the panel select is hand-rolled and posts slugs.
 */
function resolveRoleKey(token: string): string | null {
  // Full key first — it's the storage shape used elsewhere in the bot.
  if (findStaffRoleDefByKey(token)) return token
  const bySlug = findStaffRoleDefBySlug(token)
  return bySlug ? bySlug.key : null
}

export const grantHandler: VerbHandler = async (params, ctx) => {
  if (!isGrantParams(params)) {
    return { ok: false, error: 'bad-params', details: 'expected { userId, roleKey }' }
  }

  const roleKey = resolveRoleKey(params.roleKey)
  if (!roleKey) {
    return { ok: false, error: 'role-key-unknown', details: params.roleKey }
  }
  const def = findStaffRoleDefByKey(roleKey)!  // resolveRoleKey guarantees this

  const roleId = getSetting(roleKey)
  if (!roleId) {
    return {
      ok: false,
      error: 'role-not-linked',
      details: `${def.label} has no linked Discord role — run /sudo → Settings → Staff Roles → Provision & link first`,
    }
  }

  const guild = ctx.client.guilds.cache.get(env.GUILD_ID)
    ?? await ctx.client.guilds.fetch(env.GUILD_ID).catch(() => null)
  if (!guild) {
    return { ok: false, error: 'guild-unavailable', details: env.GUILD_ID }
  }

  const role = guild.roles.cache.get(roleId)
    ?? await guild.roles.fetch(roleId).catch(() => null)
  if (!role) {
    return {
      ok: false,
      error: 'role-missing-in-guild',
      details: `${def.label} linked to ${roleId} — that role no longer exists in Discord`,
    }
  }

  const member = await guild.members.fetch(params.userId).catch(() => null)
  if (!member) {
    return { ok: false, error: 'user-not-found', details: params.userId }
  }

  // Idempotent: already-had-role is a success, not a no-op error. Callers
  // (panel + bot interaction) treat both the same way — the role is on
  // the member, which is the only outcome they care about.
  if (member.roles.cache.has(role.id)) {
    logger.info(`staff.grant: ${member.user.tag} already has ${def.label} (${role.id}) — idempotent ok`)
    return { ok: true, data: { roleId: role.id, roleName: role.name, alreadyHad: true } }
  }

  try {
    await member.roles.add(role, 'staff role grant via panel RPC')
    logger.info(`staff.grant: granted ${def.label} (${role.id}) to ${member.user.tag}`)
    return { ok: true, data: { roleId: role.id, roleName: role.name } }
  } catch (err) {
    const msg = (err as Error)?.message ?? 'unknown'
    logger.warn(`staff.grant: failed to grant ${def.label} to ${params.userId}: ${msg}`)
    return { ok: false, error: 'discord-error', details: msg }
  }
}

registerVerb('staff.grant', grantHandler)
