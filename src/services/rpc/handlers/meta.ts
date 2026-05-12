/**
 * `meta.*` RPC verbs — read-only listings of guild metadata for panel-side
 * pickers (Wave 7d). All three verbs read straight from the bot's cache —
 * `client.guilds.cache.get(env.GUILD_ID)` — and never hit the Discord API.
 * The gateway has already populated those caches by the time RPC fires, so
 * a listing is a couple of in-memory iterations.
 *
 *  - `meta.list_roles` — `{}` → `{ roles: [{id,name,color,position,managed,
 *     hoisted,mentionable}] }`. Sorted by position desc (highest first) so
 *     the panel can render them top-down without re-sorting.
 *  - `meta.list_channels` — `{ types?: Type[] }` → `{ channels: [{id,name,
 *     type,parentId,position}] }`. Optional `types` filter accepts the
 *     friendly tokens panel-side sends (`text`, `voice`, `category`,
 *     `forum`, `announcement`); we map them to the discord.js
 *     `ChannelType` enum. Sort: parentId asc, then position asc, so a
 *     dropdown grouped by category stays in Discord's display order.
 *  - `meta.list_members` — `{ query?: string, limit?: number }` →
 *     `{ members: [{id,username,displayName,avatarUrl}] }`. `query` is
 *     case-insensitive `includes` over username + displayName. `limit`
 *     defaults to 25, clamped to 100 — the panel uses this for typeahead,
 *     not full-roster export.
 *
 * Why three verbs and not one: each shape has different cache costs and
 * different invalidation rhythms (roles change rarely, members change
 * constantly), and the panel caches roles/channels for 60s but typeaheads
 * members live. Keeping them separate keeps each side simple.
 */
import { ChannelType, type GuildBasedChannel } from 'discord.js'
import { registerVerb, type VerbHandler } from '../registry'
import { env } from '../../../config/env'

type ChannelTypeToken = 'text' | 'voice' | 'category' | 'forum' | 'announcement'

const CHANNEL_TYPE_MAP: Record<ChannelTypeToken, ChannelType[]> = {
  text: [ChannelType.GuildText],
  voice: [ChannelType.GuildVoice, ChannelType.GuildStageVoice],
  category: [ChannelType.GuildCategory],
  forum: [ChannelType.GuildForum],
  announcement: [ChannelType.GuildAnnouncement],
}

function channelTypeToken(t: ChannelType): ChannelTypeToken | 'other' {
  switch (t) {
    case ChannelType.GuildText: return 'text'
    case ChannelType.GuildVoice:
    case ChannelType.GuildStageVoice: return 'voice'
    case ChannelType.GuildCategory: return 'category'
    case ChannelType.GuildForum: return 'forum'
    case ChannelType.GuildAnnouncement: return 'announcement'
    default: return 'other'
  }
}

export const listRolesHandler: VerbHandler = async (_params, ctx) => {
  const guild = ctx.client.guilds.cache.get(env.GUILD_ID)
  if (!guild) {
    return { ok: false, error: 'guild-unavailable', details: env.GUILD_ID }
  }

  const roles = guild.roles.cache
    .map(r => ({
      id: r.id,
      name: r.name,
      color: r.color,
      position: r.position,
      managed: r.managed,
      hoisted: r.hoist,
      mentionable: r.mentionable,
    }))
    .sort((a, b) => b.position - a.position)

  return { ok: true, data: { roles } }
}

export const listChannelsHandler: VerbHandler = async (params, ctx) => {
  const guild = ctx.client.guilds.cache.get(env.GUILD_ID)
  if (!guild) {
    return { ok: false, error: 'guild-unavailable', details: env.GUILD_ID }
  }

  // Build the allow-set of ChannelType enum values from any caller-supplied
  // friendly tokens. No `types` (or empty array) = include every channel.
  let allowedTypes: Set<ChannelType> | null = null
  if (params && typeof params === 'object') {
    const raw = (params as Record<string, unknown>).types
    if (Array.isArray(raw) && raw.length > 0) {
      allowedTypes = new Set()
      for (const tok of raw) {
        if (typeof tok !== 'string') continue
        const mapped = CHANNEL_TYPE_MAP[tok as ChannelTypeToken]
        if (mapped) for (const ct of mapped) allowedTypes.add(ct)
      }
    }
  }

  const channels = guild.channels.cache
    .filter((c: GuildBasedChannel): c is GuildBasedChannel => {
      if (!allowedTypes) return true
      return allowedTypes.has(c.type as ChannelType)
    })
    .map(c => ({
      id: c.id,
      name: c.name,
      type: channelTypeToken(c.type as ChannelType),
      parentId: 'parentId' in c ? (c as { parentId: string | null }).parentId : null,
      position: 'position' in c ? (c as { position: number }).position : 0,
    }))
    .sort((a, b) => {
      // Sort categories first so the panel can render a category and then
      // its children below; then within a parent, by Discord's position.
      const ap = a.parentId ?? ''
      const bp = b.parentId ?? ''
      if (ap !== bp) return ap.localeCompare(bp)
      return a.position - b.position
    })

  return { ok: true, data: { channels } }
}

const DEFAULT_MEMBER_LIMIT = 25
const MAX_MEMBER_LIMIT = 100

export const listMembersHandler: VerbHandler = async (params, ctx) => {
  const guild = ctx.client.guilds.cache.get(env.GUILD_ID)
  if (!guild) {
    return { ok: false, error: 'guild-unavailable', details: env.GUILD_ID }
  }

  let query = ''
  let limit = DEFAULT_MEMBER_LIMIT
  if (params && typeof params === 'object') {
    const p = params as Record<string, unknown>
    if (typeof p.query === 'string') query = p.query.trim().toLowerCase()
    if (typeof p.limit === 'number' && Number.isFinite(p.limit)) {
      limit = Math.max(1, Math.min(MAX_MEMBER_LIMIT, Math.floor(p.limit)))
    }
  }

  const out: { id: string; username: string; displayName: string; avatarUrl: string }[] = []
  for (const member of guild.members.cache.values()) {
    if (query) {
      const u = member.user.username.toLowerCase()
      const d = (member.displayName ?? '').toLowerCase()
      if (!u.includes(query) && !d.includes(query)) continue
    }
    out.push({
      id: member.id,
      username: member.user.username,
      displayName: member.displayName,
      avatarUrl: member.displayAvatarURL({ size: 64 }),
    })
    if (out.length >= limit) break
  }

  return { ok: true, data: { members: out } }
}

registerVerb('meta.list_roles', listRolesHandler)
registerVerb('meta.list_channels', listChannelsHandler)
registerVerb('meta.list_members', listMembersHandler)
