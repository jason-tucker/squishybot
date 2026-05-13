/**
 * `color.assign` — RPC verb that sets (or clears) a member's curated color
 * role. Mirrors the in-bot `/color` slash flow (`commands/color.ts`): swap
 * out any other curated color role the member currently holds, then add the
 * picked one — so the "one curated color at a time" invariant is preserved.
 *
 * Params: `{ userId: string, roleKey: string | null }`
 *   - `userId` is the target member's Discord snowflake.
 *   - `roleKey` is the Discord role ID of a row in `color_roles` to apply.
 *     Pass `null` to clear: every curated color role the user holds is
 *     removed and nothing replaces it.
 *
 * Naming note: the `color_roles` table is keyed by the Discord role ID
 * itself (no separate slug column — see `db/schema/roles.ts`). We use
 * `roleKey` in the verb params for symmetry with `staff.grant`'s shape;
 * the value the panel sends is the Discord role ID a sudo picked from the
 * curated dropdown.
 *
 * Reply shape:
 *   - `{ ok: true, data: { userId, roleKey, applied: boolean } }` on
 *     success. `applied` is true when at least one Discord role mutation
 *     was performed (add OR remove); false on a no-op (e.g. clearing a
 *     user who held no curated colors, or setting the role they already
 *     have).
 *   - `{ ok: false, error, details? }` on validation / Discord failure.
 *
 * Side-effect import wired into `bot/events/ready.ts` next to the other
 * RPC handler registrations. The verb is callable regardless of the
 * `feature.color_roles` flag — gating is the panel's responsibility (the
 * Color Role drill-down section is omitted entirely when the flag is
 * off, so the verb shouldn't be reached). We don't double-gate on this
 * side: an operator might legitimately reach for the verb via `/sudo`
 * tools while the public `/color` slash is gated off.
 */
import { eq } from 'drizzle-orm'
import { registerVerb, type VerbHandler } from '../registry'
import { db } from '../../../db/client'
import { colorRoles } from '../../../db/schema'
import { env } from '../../../config/env'
import { logger } from '../../logger'

type AssignParams = {
  userId: string
  roleKey: string | null
}

function isAssignParams(v: unknown): v is AssignParams {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  if (typeof p.userId !== 'string' || p.userId.length === 0) return false
  if (p.roleKey === null) return true
  return typeof p.roleKey === 'string' && p.roleKey.length > 0
}

export const colorAssignHandler: VerbHandler = async (params, ctx) => {
  if (!isAssignParams(params)) {
    return {
      ok: false,
      error: 'bad-params',
      details: 'expected { userId, roleKey: string | null }',
    }
  }

  const guild = ctx.client.guilds.cache.get(env.GUILD_ID)
    ?? await ctx.client.guilds.fetch(env.GUILD_ID).catch(() => null)
  if (!guild) {
    return { ok: false, error: 'guild-unavailable', details: env.GUILD_ID }
  }

  const member = await guild.members.fetch(params.userId).catch(() => null)
  if (!member) {
    return { ok: false, error: 'user-not-found', details: params.userId }
  }

  // Curated set — the bot stores curated color roles keyed by Discord role
  // ID, so the verb's `roleKey` is itself the ID and a non-null pick must
  // match one of these rows.
  const curated = await db
    .select()
    .from(colorRoles)
    .where(eq(colorRoles.guildId, guild.id))
  const curatedIds = new Set(curated.map((r) => r.roleId))

  if (params.roleKey !== null && !curatedIds.has(params.roleKey)) {
    return { ok: false, error: 'role-not-curated', details: params.roleKey }
  }

  let applied = false
  try {
    // Remove every curated color role the user currently holds EXCEPT
    // the one we're about to (or just want to keep) assign — matches the
    // `/color` slash behavior in `commands/color.ts`.
    for (const id of member.roles.cache.keys()) {
      if (!curatedIds.has(id)) continue
      if (params.roleKey !== null && id === params.roleKey) continue
      await member.roles
        .remove(id, 'color.assign via panel RPC')
        .catch((err) => logger.warn(`color.assign: remove ${id} from ${params.userId} failed: ${(err as Error).message}`))
      applied = true
    }

    // Set: add the target role if the user doesn't already hold it. Clear:
    // nothing to do beyond the removes above.
    if (params.roleKey !== null && !member.roles.cache.has(params.roleKey)) {
      await member.roles.add(params.roleKey, 'color.assign via panel RPC')
      applied = true
    }

    logger.info(`color.assign: user=${params.userId} roleKey=${params.roleKey ?? 'null'} applied=${applied}`)
    return {
      ok: true,
      data: { userId: params.userId, roleKey: params.roleKey, applied },
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`color.assign: discord error for user=${params.userId} roleKey=${params.roleKey ?? 'null'}: ${msg}`)
    return { ok: false, error: 'discord-error', details: msg }
  }
}

registerVerb('color.assign', colorAssignHandler)
