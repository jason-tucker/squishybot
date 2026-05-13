/**
 * `discord.create_role` — RPC verb that creates a brand-new role in the
 * configured guild on behalf of the panel.
 *
 * Existed before only as an internal side-effect of `provisionGameDiscord`;
 * this verb is the standalone entry point for the panel's "+ Create" inline
 * action that appears next to an unset view/ping-role link on the games
 * editor (see botpanel `feat/games-create-and-fill-missing`).
 *
 * Params: `{ name: string, color?: number, hoist?: boolean, mentionable?: boolean }`
 *   - `name` is trimmed; 1..100 chars after trim.
 *   - `color` accepts a 24-bit integer (0..0xFFFFFF). Discord ignores values
 *     outside that range, but we clamp early so the panel gets a clean error.
 *   - `hoist` / `mentionable` default to discord.js defaults (false / false).
 *
 * Reply:
 *   - `{ ok: true, data: { id, name, color, hoist, mentionable, position } }`.
 *   - `{ ok: false, error: 'invalid-params'|'name-too-long'|'missing-permissions'|'discord-error', details? }`.
 */
import { z } from 'zod'
import { DiscordAPIError, PermissionFlagsBits } from 'discord.js'
import { registerVerb, type VerbHandler } from '../../registry'
import { env } from '../../../../config/env'
import { logger } from '../../../logger'

const Schema = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.number().int().min(0).max(0xFFFFFF).optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
})

export const createRoleHandler: VerbHandler = async (params, ctx) => {
  const parsed = Schema.safeParse(params)
  if (!parsed.success) {
    const flat = parsed.error.flatten()
    const nameIssue = flat.fieldErrors.name?.[0]
    if (nameIssue?.includes('100')) {
      return { ok: false, error: 'name-too-long', details: nameIssue }
    }
    return { ok: false, error: 'invalid-params', details: flat }
  }
  const { name, color, hoist, mentionable } = parsed.data

  const guild = ctx.client.guilds.cache.get(env.GUILD_ID)
    ?? await ctx.client.guilds.fetch(env.GUILD_ID).catch(() => null)
  if (!guild) {
    return { ok: false, error: 'guild-unavailable', details: env.GUILD_ID }
  }

  // Quick pre-flight: if the bot's own member is missing ManageRoles, the
  // create call will 50013 anyway — surface a stable error token early so
  // the panel can render "missing permissions" without parsing API text.
  const me = guild.members.me
  if (me && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { ok: false, error: 'missing-permissions', details: 'bot lacks ManageRoles' }
  }

  try {
    const created = await guild.roles.create({
      name,
      color,
      hoist,
      mentionable,
      permissions: [],
      reason: `panel discord.create_role (rid=${ctx.requestId})`,
    })
    logger.info(`discord.create_role: created role ${created.id} name="${created.name}"`)
    return {
      ok: true,
      data: {
        id: created.id,
        name: created.name,
        color: created.color,
        hoist: created.hoist,
        mentionable: created.mentionable,
        position: created.position,
      },
    }
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === 50013) {
      return { ok: false, error: 'missing-permissions', details: err.message }
    }
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`discord.create_role: failed for name="${name}": ${msg}`)
    return { ok: false, error: 'discord-error', details: msg }
  }
}

registerVerb('discord.create_role', createRoleHandler)
