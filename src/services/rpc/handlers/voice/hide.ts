/**
 * `voice.hide` — toggle ViewChannel for `@everyone` + persist the flag.
 *
 * Params: `{ voiceChannelId: string, hidden: boolean }`.
 *
 * Mirrors the in-bot hide button (`interactions/buttons/voiceControl.ts`):
 * when hiding, deny `@everyone` ViewChannel then re-grant view to the bot,
 * owner, hosts, and sudo roles so they don't lose access to their own room.
 * When un-hiding, just null-out the @everyone overwrite — the explicit
 * allows are inert and harmless to leave in place.
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { registerVerb, type VerbHandler } from '../../registry'
import { db } from '../../../../db/client'
import { autoChannels } from '../../../../db/schema'
import { postOrUpdateControlPanel } from '../../../voice/controlPanel'
import { publish, voiceCh, type VoiceHiddenToggledEvent } from '../../../eventBus'
import { env } from '../../../../config/env'
import { logger } from '../../../logger'

const Schema = z.object({
  voiceChannelId: z.string().min(1),
  hidden: z.boolean(),
})

export const hideHandler: VerbHandler = async (params, ctx) => {
  const parsed = Schema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, error: 'invalid-params', details: parsed.error.flatten() }
  }
  const { voiceChannelId, hidden } = parsed.data

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
      const everyone = guild.roles.everyone
      if (hidden) {
        await vc.permissionOverwrites.edit(everyone, { ViewChannel: false })
        const explicitAllows = new Set<string>([
          ctx.client.user!.id,
          record.ownerUserId,
          ...record.hostUserIds,
        ])
        for (const id of explicitAllows) {
          await vc.permissionOverwrites.edit(id, { ViewChannel: true }).catch(() => {})
        }
        for (const roleId of env.SUDO_ROLE_IDS) {
          await vc.permissionOverwrites.edit(roleId, { ViewChannel: true }).catch(() => {})
        }
      } else {
        await vc.permissionOverwrites.edit(everyone, { ViewChannel: null })
      }
    }

    await db.update(autoChannels).set({ isHidden: hidden }).where(eq(autoChannels.voiceChannelId, voiceChannelId))
    const updated = { ...record, isHidden: hidden }

    void publish<VoiceHiddenToggledEvent>(voiceCh('hidden_toggled'), {
      voiceChannelId, isHidden: hidden, ts: new Date().toISOString(),
    })

    await postOrUpdateControlPanel(ctx.client, updated).catch(() => {})
    return { ok: true, data: { hidden } }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`voice.hide: discord error for vc=${voiceChannelId}: ${msg}`)
    return { ok: false, error: 'discord-error', details: msg }
  }
}

registerVerb('voice.hide', hideHandler)
