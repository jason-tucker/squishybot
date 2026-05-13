/**
 * `discord.create_channel` — RPC verb that creates a new guild channel.
 *
 * Standalone entry point for the panel's "+ Create" inline action next to
 * an unset game channel link. The bot already auto-provisions channels for
 * games via `provisionGameDiscord`, but that flow is opinionated (slug,
 * games-category-only, deny @everyone). This verb is the explicit, named,
 * panel-driven version: caller specifies the name, type, optional parent
 * category, and optional position.
 *
 * Params: `{ name, type: 'text'|'voice'|'announcement'|'forum', parentId?, position?, topic? }`
 *   - `type` is the friendly token; we map to discord.js `ChannelType`.
 *   - `parentId` must be a snowflake-shaped string (>= 17 chars); we don't
 *     verify it resolves to a category — Discord will reject if it doesn't.
 *   - `position` is the sort key within the parent (0-indexed from top).
 *   - `topic` only applies to text/announcement; ignored for voice/forum.
 *
 * Reply: `{ ok: true, data: { id, name, type, parentId, position } }` or
 * `{ ok: false, error: 'invalid-params'|'name-too-long'|'missing-permissions'|'discord-error', details? }`.
 */
import { z } from 'zod'
import { ChannelType, DiscordAPIError, PermissionFlagsBits } from 'discord.js'
import { registerVerb, type VerbHandler } from '../../registry'
import { env } from '../../../../config/env'
import { logger } from '../../../logger'

type ChannelTypeToken = 'text' | 'voice' | 'announcement' | 'forum'

// `guild.channels.create` accepts a narrow union, not the full ChannelType
// enum. Pin the map value-type to the literals so TS doesn't widen on
// dictionary lookup.
type CreatableChannelType =
  | ChannelType.GuildText
  | ChannelType.GuildVoice
  | ChannelType.GuildAnnouncement
  | ChannelType.GuildForum

const TYPE_MAP: Record<ChannelTypeToken, CreatableChannelType> = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
}

const Schema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['text', 'voice', 'announcement', 'forum']),
  parentId: z.string().min(15).max(25).optional(),
  position: z.number().int().min(0).max(1000).optional(),
  topic: z.string().max(1024).optional(),
})

export const createChannelHandler: VerbHandler = async (params, ctx) => {
  const parsed = Schema.safeParse(params)
  if (!parsed.success) {
    const flat = parsed.error.flatten()
    const nameIssue = flat.fieldErrors.name?.[0]
    if (nameIssue?.includes('100')) {
      return { ok: false, error: 'name-too-long', details: nameIssue }
    }
    return { ok: false, error: 'invalid-params', details: flat }
  }
  const { name, type, parentId, position, topic } = parsed.data

  const guild = ctx.client.guilds.cache.get(env.GUILD_ID)
    ?? await ctx.client.guilds.fetch(env.GUILD_ID).catch(() => null)
  if (!guild) {
    return { ok: false, error: 'guild-unavailable', details: env.GUILD_ID }
  }

  const me = guild.members.me
  if (me && !me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { ok: false, error: 'missing-permissions', details: 'bot lacks ManageChannels' }
  }

  const discordType = TYPE_MAP[type]
  const supportsTopic = discordType === ChannelType.GuildText || discordType === ChannelType.GuildAnnouncement

  try {
    const created = await guild.channels.create({
      name,
      type: discordType,
      parent: parentId,
      position,
      topic: supportsTopic ? topic : undefined,
      reason: `panel discord.create_channel (rid=${ctx.requestId})`,
    })
    logger.info(`discord.create_channel: created channel ${created.id} name="${created.name}" type=${type}`)
    return {
      ok: true,
      data: {
        id: created.id,
        name: created.name,
        type,
        parentId: created.parentId,
        position: created.position,
      },
    }
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === 50013) {
      return { ok: false, error: 'missing-permissions', details: err.message }
    }
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`discord.create_channel: failed for name="${name}": ${msg}`)
    return { ok: false, error: 'discord-error', details: msg }
  }
}

registerVerb('discord.create_channel', createChannelHandler)
