/**
 * `admin.orphan_scan` — read-only walk of bot-managed tables to surface
 * Discord references that no longer exist in cache.
 *
 * Mirrors the `renderOrphanScan` function in `src/interactions/sudoSettings.ts`
 * (#16) — keep the two in sync. Walks the same five tables:
 *   - `auto_channels`        (voice_channel_id, text_channel_id)
 *   - `hub_channels`         (channel_id, category_id)
 *   - `auto_thread_channels` (channel_id)
 *   - `games`                (channel_id, category_id, role_id, ping_role_id)
 *   - `archived_channels`    (channel_id)
 *
 * Reply: `{ ok: true, data: { orphans: [{table, id, reason}, ...] } }`.
 * The `reason` carries the column name (e.g. `voice_channel_id missing`)
 * so the panel UI can render a readable table without having to interpret
 * field names itself.
 *
 * This verb does NOT delete anything — cleanup remains a separate, explicit
 * action surfaced inside Discord (`sudo:set:debug:cleanup_orphans`) so a
 * panel button can't blow away rows without a Discord-side confirmation.
 */
import type { Guild } from 'discord.js'
import { registerVerb, type VerbHandler } from '../../registry'
import { env } from '../../../../config/env'

type Orphan = { table: string; id: string; reason: string }

export const orphanScanHandler: VerbHandler = async (_params, ctx) => {
  // Fetch guild via cache first, fall back to API. Matches the reconciler's
  // pattern — first-boot races where the guild isn't yet cached shouldn't
  // synthesize a "no orphans" reply.
  const guild: Guild | null =
    ctx.client.guilds.cache.get(env.GUILD_ID)
    ?? (await ctx.client.guilds.fetch(env.GUILD_ID).catch(() => null))

  if (!guild) {
    return { ok: false, error: 'guild-not-available' }
  }

  const { db } = await import('../../../../db/client')
  const {
    autoChannels,
    hubChannels,
    autoThreadChannels,
    games,
    archivedChannels,
  } = await import('../../../../db/schema')

  const [autoRows, hubRows, threadRows, gameRows, archivedRows] = await Promise.all([
    db.select().from(autoChannels),
    db.select().from(hubChannels),
    db.select().from(autoThreadChannels),
    db.select().from(games),
    db.select().from(archivedChannels),
  ])

  const orphans: Orphan[] = []
  const seenInDiscord = (id: string | null | undefined): boolean =>
    !!(id && guild.channels.cache.has(id))
  const roleSeen = (id: string | null | undefined): boolean =>
    !!(id && guild.roles.cache.has(id))

  for (const r of autoRows) {
    if (!seenInDiscord(r.voiceChannelId)) {
      orphans.push({ table: 'auto_channels', id: r.id, reason: `voice_channel_id ${r.voiceChannelId} missing` })
    }
    if (!seenInDiscord(r.textChannelId)) {
      orphans.push({ table: 'auto_channels', id: r.id, reason: `text_channel_id ${r.textChannelId} missing` })
    }
  }
  for (const r of hubRows) {
    if (!seenInDiscord(r.channelId)) {
      orphans.push({ table: 'hub_channels', id: r.id, reason: `channel_id ${r.channelId} missing` })
    }
    if (!seenInDiscord(r.categoryId)) {
      orphans.push({ table: 'hub_channels', id: r.id, reason: `category_id ${r.categoryId} missing` })
    }
  }
  for (const r of threadRows) {
    if (!seenInDiscord(r.channelId)) {
      orphans.push({ table: 'auto_thread_channels', id: r.channelId, reason: `channel_id ${r.channelId} missing` })
    }
  }
  for (const r of gameRows) {
    if (r.channelId && !seenInDiscord(r.channelId)) {
      orphans.push({ table: 'games', id: r.id, reason: `channel_id ${r.channelId} missing` })
    }
    if (r.categoryId && !seenInDiscord(r.categoryId)) {
      orphans.push({ table: 'games', id: r.id, reason: `category_id ${r.categoryId} missing` })
    }
    if (r.roleId && !roleSeen(r.roleId)) {
      orphans.push({ table: 'games', id: r.id, reason: `role_id ${r.roleId} missing` })
    }
    if (r.pingRoleId && !roleSeen(r.pingRoleId)) {
      orphans.push({ table: 'games', id: r.id, reason: `ping_role_id ${r.pingRoleId} missing` })
    }
  }
  for (const r of archivedRows) {
    if (!seenInDiscord(r.channelId)) {
      orphans.push({ table: 'archived_channels', id: r.channelId, reason: `channel_id ${r.channelId} missing` })
    }
  }

  return {
    ok: true,
    data: { orphans },
  }
}

registerVerb('admin.orphan_scan', orphanScanHandler)
