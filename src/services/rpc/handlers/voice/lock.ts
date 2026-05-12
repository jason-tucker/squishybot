/**
 * `voice.lock` — toggle `@everyone` Connect perm + persist the flag.
 *
 * Params: `{ voiceChannelId: string, locked: boolean }`.
 *
 * Mirrors the in-bot lock button (`interactions/buttons/voiceControl.ts`):
 * edit the `@everyone` overwrite (Connect=false to lock, null to unlock),
 * flip `is_locked` in the DB, publish the lock-toggled event, refresh the
 * panel so in-channel viewers see the change immediately.
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { registerVerb, type VerbHandler } from '../../registry'
import { db } from '../../../../db/client'
import { autoChannels } from '../../../../db/schema'
import { postOrUpdateControlPanel } from '../../../voice/controlPanel'
import { publish, voiceCh, type VoiceLockToggledEvent } from '../../../eventBus'
import { logger } from '../../../logger'

const Schema = z.object({
  voiceChannelId: z.string().min(1),
  locked: z.boolean(),
})

export const lockHandler: VerbHandler = async (params, ctx) => {
  const parsed = Schema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, error: 'invalid-params', details: parsed.error.flatten() }
  }
  const { voiceChannelId, locked } = parsed.data

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) {
    return { ok: false, error: 'channel-not-found' }
  }

  const guild = ctx.client.guilds.cache.get(record.guildId)
  if (!guild) {
    return { ok: false, error: 'guild-not-found' }
  }

  try {
    const vc = await guild.channels.fetch(record.voiceChannelId).catch(() => null)
    if (vc?.isVoiceBased()) {
      await vc.permissionOverwrites.edit(guild.roles.everyone, { Connect: locked ? false : null })
    }

    await db.update(autoChannels).set({ isLocked: locked }).where(eq(autoChannels.voiceChannelId, voiceChannelId))
    const updated = { ...record, isLocked: locked }

    void publish<VoiceLockToggledEvent>(voiceCh('lock_toggled'), {
      voiceChannelId, isLocked: locked, ts: new Date().toISOString(),
    })

    await postOrUpdateControlPanel(ctx.client, updated).catch(() => {})
    return { ok: true, data: { locked } }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`voice.lock: discord error for vc=${voiceChannelId}: ${msg}`)
    return { ok: false, error: 'discord-error', details: msg }
  }
}

registerVerb('voice.lock', lockHandler)
