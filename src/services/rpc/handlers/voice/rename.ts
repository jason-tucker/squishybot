/**
 * `voice.rename` — rename an auto-channel from the panel.
 *
 * Params: `{ voiceChannelId: string, newName: string }`.
 *
 * Mirrors the in-bot rename flow (`interactions/modals/voiceRename.ts`):
 * sanitize → set the voice channel name → set the text channel name to a
 * slugified copy → persist `manualName`, `autoNameEnabled=false`,
 * `fallbackName` on the row → refresh the in-channel control panel so
 * Discord viewers see the same state the panel just wrote.
 */
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { registerVerb, type VerbHandler } from '../../registry'
import { db } from '../../../../db/client'
import { autoChannels } from '../../../../db/schema'
import { sanitizeChannelName } from '../../../../utils/channelName'
import { decorateChannelName } from '../../../voice/autoNaming'
import { postOrUpdateControlPanel } from '../../../voice/controlPanel'
import { logger } from '../../../logger'

const Schema = z.object({
  voiceChannelId: z.string().min(1),
  newName: z.string().min(1).max(100),
})

export const renameHandler: VerbHandler = async (params, ctx) => {
  const parsed = Schema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, error: 'invalid-params', details: parsed.error.flatten() }
  }
  const { voiceChannelId, newName: rawName } = parsed.data

  const sanitized = sanitizeChannelName(rawName)
  if (!sanitized) {
    return { ok: false, error: 'invalid-name' }
  }

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) {
    return { ok: false, error: 'channel-not-found' }
  }

  const guild = ctx.client.guilds.cache.get(record.guildId)
  if (!guild) {
    return { ok: false, error: 'guild-not-found' }
  }

  try {
    const [vc, tc] = await Promise.all([
      guild.channels.fetch(record.voiceChannelId).catch(() => null),
      guild.channels.fetch(record.textChannelId).catch(() => null),
    ])
    // DB keeps the typed name undecorated; the visible name gets a trailing
    // emoji + collision dodge — same rule as the in-bot rename flow.
    const finalName = vc?.isVoiceBased() ? decorateChannelName(guild, sanitized, vc.id) : sanitized
    const textName = finalName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice-chat'

    await Promise.all([
      vc?.isVoiceBased() ? vc.setName(finalName) : Promise.resolve(),
      tc?.isTextBased() ? (tc as { setName: (n: string) => Promise<unknown> }).setName(textName) : Promise.resolve(),
    ])

    await db.update(autoChannels)
      .set({ manualName: sanitized, autoNameEnabled: false, fallbackName: sanitized })
      .where(eq(autoChannels.voiceChannelId, voiceChannelId))

    const updated = { ...record, manualName: sanitized, autoNameEnabled: false, fallbackName: sanitized }
    await postOrUpdateControlPanel(ctx.client, updated).catch(() => {})

    return { ok: true, data: { newName: finalName } }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    logger.warn(`voice.rename: discord error for vc=${voiceChannelId}: ${msg}`)
    return { ok: false, error: 'discord-error', details: msg }
  }
}

registerVerb('voice.rename', renameHandler)
