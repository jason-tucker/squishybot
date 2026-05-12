/**
 * `staff.revoke` — RPC verb that removes one of the 7 staff roles from a
 * Discord member. Mirror of `staff.grant` — same param shape, same role-key
 * normalization, same error-token taxonomy so the panel can render either
 * outcome with the same handling.
 *
 * Params: `{ userId, roleKey }` — `roleKey` can be the full `staff.role.*`
 * key or the bare slug (`tier_1`); we normalize via the staff-role registry.
 *
 * Reply:
 *  - `{ ok: true, data: { roleId, roleName, didNotHave? } }` on success.
 *    `didNotHave: true` when the member didn't actually have the role —
 *    callers should treat this as a successful revoke (target state achieved)
 *    but may want to surface "already didn't have" to the operator.
 *  - `{ ok: false, error, details? }` mirrors the grant verb's error tokens.
 *
 * Side-effects: info-log on success, warn on Discord failure. Same audit
 * surface as grant on the panel side — paired actions, paired logging.
 */
import { registerVerb, type VerbHandler } from '../../registry'
import { env } from '../../../../config/env'
import { logger } from '../../../logger'
import { getSetting } from '../../../settings'
import { findStaffRoleDefByKey, findStaffRoleDefBySlug } from '../../../staffRoles'

type RevokeParams = {
  userId: string
  roleKey: string
}

function isRevokeParams(v: unknown): v is RevokeParams {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return typeof p.userId === 'string' && p.userId.length > 0
      && typeof p.roleKey === 'string' && p.roleKey.length > 0
}

function resolveRoleKey(token: string): string | null {
  if (findStaffRoleDefByKey(token)) return token
  const bySlug = findStaffRoleDefBySlug(token)
  return bySlug ? bySlug.key : null
}

export const revokeHandler: VerbHandler = async (params, ctx) => {
  if (!isRevokeParams(params)) {
    return { ok: false, error: 'bad-params', details: 'expected { userId, roleKey }' }
  }

  const roleKey = resolveRoleKey(params.roleKey)
  if (!roleKey) {
    return { ok: false, error: 'role-key-unknown', details: params.roleKey }
  }
  const def = findStaffRoleDefByKey(roleKey)!

  const roleId = getSetting(roleKey)
  if (!roleId) {
    return {
      ok: false,
      error: 'role-not-linked',
      details: `${def.label} has no linked Discord role — nothing to revoke`,
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

  if (!member.roles.cache.has(role.id)) {
    logger.info(`staff.revoke: ${member.user.tag} did not have ${def.label} (${role.id}) — idempotent ok`)
    return { ok: true, data: { roleId: role.id, roleName: role.name, didNotHave: true } }
  }

  try {
    await member.roles.remove(role, 'staff role revoke via panel RPC')
    logger.info(`staff.revoke: removed ${def.label} (${role.id}) from ${member.user.tag}`)
    return { ok: true, data: { roleId: role.id, roleName: role.name } }
  } catch (err) {
    const msg = (err as Error)?.message ?? 'unknown'
    logger.warn(`staff.revoke: failed to remove ${def.label} from ${params.userId}: ${msg}`)
    return { ok: false, error: 'discord-error', details: msg }
  }
}

registerVerb('staff.revoke', revokeHandler)
