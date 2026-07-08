/**
 * `voice.transfer` — change the auto-channel owner immediately.
 *
 * Params: `{ voiceChannelId: string, newOwnerUserId: string }`.
 *
 * Mirrors the in-bot Force-owner-transfer flow
 * (`interactions/forceOwnerTransfer.ts`): cancel any active grace timer,
 * drop the new owner from `hostUserIds` if they were a host, clear the
 * acting-owner fields, resync the text-channel permission overwrites so the
 * new owner has the right access, publish the owner-changed event, and
 * refresh the in-channel control panel.
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { registerVerb, type VerbHandler } from '../../registry'
import { db } from '../../../../db/client'
import { autoChannels } from '../../../../db/schema'
import { cancelGraceTimer } from '../../../voice/ownerGrace'
import { syncTextChannelPermissions } from '../../../voice/permissions'
import { postOrUpdateControlPanel } from '../../../voice/controlPanel'
import { publish, voiceCh, type VoiceOwnerChangedEvent } from '../../../eventBus'
import { logChannelEvent } from '../../../voice/channelLog'
import { logger } from '../../../logger'

const Schema = z.object({
  voiceChannelId: z.string().min(1),
  newOwnerUserId: z.string().min(1),
})

export const transferHandler: VerbHandler = async (params, ctx) => {
  const parsed = Schema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, error: 'invalid-params', details: parsed.error.flatten() }
  }
  const { voiceChannelId, newOwnerUserId } = parsed.data

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) {
    return { ok: false, error: 'channel-not-found' }
  }

  if (record.ownerUserId === newOwnerUserId) {
    return { ok: false, error: 'already-owner' }
  }

  const guild = ctx.client.guilds.cache.get(record.guildId)
  if (!guild) {
    return { ok: false, error: 'guild-not-found' }
  }

  try {
    cancelGraceTimer(voiceChannelId)

    const newHosts = record.hostUserIds.filter(id => id !== newOwnerUserId)
    const [updated] = await db.update(autoChannels)
      .set({
        ownerUserId: newOwnerUserId,
        hostUserIds: newHosts,
        actingOwnerUserId: null,
        ownerGraceExpiresAt: null,
      })
      .where(eq(autoChannels.voiceChannelId, voiceChannelId))
      .returning()
    logChannelEvent({ voiceChannelId, guildId: record.guildId, type: 'owner_transfer', actorUserId: newOwnerUserId })

    // Resync text-channel perms so the new owner has the right overwrite.
    // Best-effort — if the channels are missing we still report success on
    // the DB row (the bot reconciler will catch up on the next event).
    try {
      const vc = guild.channels.cache.get(voiceChannelId) ?? await guild.channels.fetch(voiceChannelId).catch(() => null)
      const tc = guild.channels.cache.get(record.textChannelId) ?? await guild.channels.fetch(record.textChannelId).catch(() => null)
      if (vc?.isVoiceBased() && tc?.isTextBased()) {
        await syncTextChannelPermissions(tc as any, vc as any, updated, ctx.client.user!.id)
      }
    } catch (err) {
      logger.warn(`voice.transfer: permission resync failed for vc=${voiceChannelId}: ${(err as Error).message}`)
    }

    void publish<VoiceOwnerChangedEvent>(voiceCh('owner_changed'), {
      voiceChannelId,
      oldOwnerUserId: record.ownerUserId,
      newOwnerUserId,
      ts: new Date().toISOString(),
    })

    await postOrUpdateControlPanel(ctx.client, updated).catch(() => {})

    logger.info(`voice.transfer: vc=${voiceChannelId} ${record.ownerUserId} → ${newOwnerUserId} (via rpc)`)
    return { ok: true, data: { newOwnerUserId } }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`voice.transfer: error for vc=${voiceChannelId}: ${msg}`)
    return { ok: false, error: 'discord-error', details: msg }
  }
}

registerVerb('voice.transfer', transferHandler)
