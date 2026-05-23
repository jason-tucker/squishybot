/**
 * Voice host add/remove — extracted from the slash select-menu handler so
 * the panel's `voice.toggle_host` RPC verb shares the same implementation.
 *
 * Behavior matches `/voice → Hosts` exactly:
 *  - Race-safe SQL array mutation (no read-modify-write).
 *  - Text-channel permission sync after the array change so the new host
 *    gets / loses access to the text channel.
 *  - When the VC is hidden, hosts get an explicit `ViewChannel: true`
 *    overwrite so they can find the room from the channel list.
 *  - Updates the control-panel message in the attached text channel.
 *  - Fires the same `voice.hosts_changed` event over Redis so any other
 *    subscriber (panel SSE, future automations) sees the mutation.
 */
import type { Client } from 'discord.js'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { env } from '../../config/env'
import { logger } from '../logger'
import { getIntSetting } from '../settings'
import { syncTextChannelPermissions } from './permissions'
import { postOrUpdateControlPanel } from './controlPanel'
import { publish, voiceCh, type VoiceHostsChangedEvent } from '../eventBus'

export type ToggleHostInput = {
  client: Client
  voiceChannelId: string
  userId: string
  op: 'add' | 'remove'
}

export type ToggleHostResult =
  | { ok: true; data: { hostUserIds: string[] } }
  | {
      ok: false
      error:
        | 'channel-not-found'
        | 'is-owner'
        | 'voice-channel-fetch-failed'
        | 'db-error'
        | 'host-cap-reached'
      details?: string
    }

export async function toggleHost(input: ToggleHostInput): Promise<ToggleHostResult> {
  const { client, voiceChannelId, userId, op } = input

  // Look up the channel record — abort early if it's gone.
  const [record] = await db
    .select()
    .from(autoChannels)
    .where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) return { ok: false, error: 'channel-not-found' }

  // Owner can't be host-toggled — that role is implicit.
  if (record.ownerUserId === userId) return { ok: false, error: 'is-owner' }

  // Enforce the per-channel host cap on add. 0 (the default) means "unlimited";
  // any positive integer is treated as a hard cap. Removals are always allowed
  // even when at/over the cap so an operator can lower the setting and prune.
  if (op === 'add' && !record.hostUserIds.includes(userId)) {
    const cap = getIntSetting('voice.max_hosts_per_channel', 0, { min: 0, max: 50 })
    if (cap > 0 && record.hostUserIds.length >= cap) {
      return {
        ok: false,
        error: 'host-cap-reached',
        details: `cap=${cap} current=${record.hostUserIds.length}`,
      }
    }
  }

  const guild = client.guilds.cache.get(env.GUILD_ID)
  if (!guild) return { ok: false, error: 'voice-channel-fetch-failed' }

  let updatedRow
  try {
    const expr =
      op === 'add'
        ? sql`(SELECT array_agg(DISTINCT x) FROM unnest(${autoChannels.hostUserIds} || ARRAY[${userId}]::text[]) AS x)`
        : sql`array_remove(${autoChannels.hostUserIds}, ${userId})`
    const rows = await db
      .update(autoChannels)
      .set({ hostUserIds: expr })
      .where(eq(autoChannels.voiceChannelId, voiceChannelId))
      .returning()
    updatedRow = rows[0]
  } catch (err) {
    return {
      ok: false,
      error: 'db-error',
      details: err instanceof Error ? err.message : String(err),
    }
  }

  const updated = updatedRow ?? { ...record, hostUserIds: record.hostUserIds }

  const vc =
    guild.channels.cache.get(record.voiceChannelId) ??
    (await guild.channels.fetch(record.voiceChannelId).catch(() => null))
  const tc =
    guild.channels.cache.get(record.textChannelId) ??
    (await guild.channels.fetch(record.textChannelId).catch(() => null))
  if (vc?.isVoiceBased() && tc?.isTextBased()) {
    await syncTextChannelPermissions(tc as any, vc as any, updated, client.user!.id).catch(() => {})
    if (record.isHidden) {
      if (op === 'add') {
        await vc.permissionOverwrites.edit(userId, { ViewChannel: true }).catch(() => {})
      } else {
        await vc.permissionOverwrites.edit(userId, { ViewChannel: null }).catch(() => {})
      }
    }
  }

  await postOrUpdateControlPanel(client, updated).catch(() => {})

  void publish<VoiceHostsChangedEvent>(voiceCh('hosts_changed'), {
    voiceChannelId,
    op,
    userId,
    ts: new Date().toISOString(),
  })

  logger.info(
    `Hosts ${op}: ${userId} ${op === 'add' ? '→' : '←'} vc=${voiceChannelId} (now ${updated.hostUserIds.length} hosts)`,
  )
  return { ok: true, data: { hostUserIds: updated.hostUserIds } }
}
