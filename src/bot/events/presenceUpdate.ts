import type { Client, Presence } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { maybeRenameChannel, clearRenameState } from '../../services/voice/autoRename'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'
import { getBoolSetting } from '../../services/settings'
import { logger } from '../../services/logger'

/** Drop the per-channel rename state when an auto-channel is deleted. */
export function clearRenameThrottle(voiceChannelId: string): void {
  clearRenameState(voiceChannelId)
}

export function registerPresenceUpdate(client: Client): void {
  client.on('presenceUpdate', async (_old: Presence | null, newPresence: Presence) => {
    if (newPresence.guild?.id !== env.GUILD_ID) return
    if (!newPresence.userId) return

    // Keying off voice-channel rather than ownership lets a non-owner's
    // game activity drive the name (and the panel rich-presence list).
    const memberVcId = newPresence.member?.voice.channelId
    if (!memberVcId) return

    // Only fire the heavy paths when the user is actually in an auto channel.
    const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, memberVcId))
    if (!record) return

    // Rename pipeline — gated by feature.presence_renames so the kill switch
    // works. Panel refresh runs independently so the rich-presence list and
    // "why this name" line stay current even when renames are disabled.
    if (getBoolSetting('feature.presence_renames', true)) {
      await maybeRenameChannel(client, memberVcId).catch(err =>
        logger.warn(`presenceUpdate rename: ${(err as Error).message}`),
      )
    }
    // The control panel's hash dedup will skip no-op edits, so this is cheap
    // when the user's relevant presence fields didn't change.
    await postOrUpdateControlPanel(client, record).catch(() => {})
  })
}
