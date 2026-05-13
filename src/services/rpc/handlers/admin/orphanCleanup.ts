/**
 * `admin.orphan_cleanup` — delete bot-managed DB rows whose Discord
 * references are entirely gone.
 *
 * Mirrors the in-Discord "Clean up orphan rows" button at
 * `sudo:set:debug:cleanup_orphans` (see `interactions/sudoSettings.ts`).
 * Walks the same four tables (auto_channels, hub_channels,
 * auto_thread_channels, archived_channels) and deletes a row only when
 * **every** Discord reference on it is missing. Rows with PARTIALLY-
 * missing references (e.g. a game with a stale ping_role_id but a valid
 * channel_id) are intentionally left alone — those still represent real
 * data the user can repair via the Games panel.
 *
 * Authorization: the panel route gates on bot-owner before publishing,
 * and the bot enforces the same posture in the in-Discord button. There's
 * no per-verb gate here because the RPC bus is itself an HMAC-protected
 * privileged channel; the panel is the only legit publisher.
 *
 * Reply: `{ ok: true, data: { deleted, byTable: {table: n, ...} } }`.
 * `byTable` gives the panel a per-table summary so the UI can render a
 * line per table instead of just a total.
 */
import { eq } from 'drizzle-orm'
import type { Guild } from 'discord.js'
import { registerVerb, type VerbHandler } from '../../registry'
import { env } from '../../../../config/env'

export const orphanCleanupHandler: VerbHandler = async (_params, ctx) => {
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
    archivedChannels,
  } = await import('../../../../db/schema')

  const [autoRows, hubRows, threadRows, archivedRows] = await Promise.all([
    db.select().from(autoChannels),
    db.select().from(hubChannels),
    db.select().from(autoThreadChannels),
    db.select().from(archivedChannels),
  ])

  const byTable: Record<string, number> = {
    auto_channels: 0,
    hub_channels: 0,
    auto_thread_channels: 0,
    archived_channels: 0,
  }
  let deleted = 0
  const present = (id: string | null | undefined): boolean =>
    !!(id && guild.channels.cache.has(id))

  for (const r of autoRows) {
    if (!present(r.voiceChannelId) && !present(r.textChannelId)) {
      await db.delete(autoChannels).where(eq(autoChannels.id, r.id)).catch(() => {})
      byTable.auto_channels++
      deleted++
    }
  }
  for (const r of hubRows) {
    if (!present(r.channelId)) {
      await db.delete(hubChannels).where(eq(hubChannels.id, r.id)).catch(() => {})
      byTable.hub_channels++
      deleted++
    }
  }
  for (const r of threadRows) {
    if (!present(r.channelId)) {
      await db
        .delete(autoThreadChannels)
        .where(eq(autoThreadChannels.channelId, r.channelId))
        .catch(() => {})
      byTable.auto_thread_channels++
      deleted++
    }
  }
  for (const r of archivedRows) {
    if (!present(r.channelId)) {
      await db
        .delete(archivedChannels)
        .where(eq(archivedChannels.channelId, r.channelId))
        .catch(() => {})
      byTable.archived_channels++
      deleted++
    }
  }

  // Settings cache reload — matches the in-Discord cleanup path so the
  // in-memory state stays consistent after row deletes.
  const { loadSettings } = await import('../../../settings')
  await loadSettings().catch(() => {})

  return { ok: true, data: { deleted, byTable } }
}

registerVerb('admin.orphan_cleanup', orphanCleanupHandler)
