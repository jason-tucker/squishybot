import type { Client, Presence } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { logger } from '../../services/logger'
import { computeAutoName } from '../../services/voice/autoNaming'

// Debounce: don't rename more than once per 10 minutes per channel (Discord rate limit)
const lastRename = new Map<string, number>()
const RENAME_COOLDOWN_MS = 10 * 60 * 1000

/** Drop the throttle entry when an auto-channel is deleted, otherwise the Map
 * leaks one entry per channel ever auto-renamed. Called from deleteAutoChannel. */
export function clearRenameThrottle(voiceChannelId: string): void {
  lastRename.delete(voiceChannelId)
}

export function registerPresenceUpdate(client: Client): void {
  client.on('presenceUpdate', async (_old: Presence | null, newPresence: Presence) => {
    if (newPresence.guild?.id !== env.GUILD_ID) return
    if (!newPresence.userId) return

    // Look up the auto channel the user is currently sitting in (if any).
    // Tracking by voice-channel rather than ownership lets a non-owner's
    // game activity influence the name, which is needed for the "(N) Game"
    // counted-name feature when multiple members are playing the same thing.
    const memberVcId = newPresence.member?.voice.channelId
    if (!memberVcId) return
    const [record] = await db.select().from(autoChannels)
      .where(eq(autoChannels.voiceChannelId, memberVcId))

    if (!record) return
    if (!record.autoNameEnabled) return
    // nameTemplate semantics:
    //   null   → default auto (just the game name) — fresh channels land here
    //   'auto' → same: just the game name
    //   'counter' → "<game> [N/limit]"
    //   anything else → manual mode (e.g. tryhard / chill / custom rename); skip
    if (record.nameTemplate !== null && record.nameTemplate !== 'auto' && record.nameTemplate !== 'counter') return

    // Rate limit check
    const lastTime = lastRename.get(record.voiceChannelId) ?? 0
    if (Date.now() - lastTime < RENAME_COOLDOWN_MS) return

    const guild = client.guilds.cache.get(env.GUILD_ID)
    if (!guild) return

    const vc = await guild.channels.fetch(record.voiceChannelId).catch(() => null)
    if (!vc?.isVoiceBased()) return

    // When nobody is playing anything we can derive a name from, fall back to
    // the channel's stored fallbackName (initial random name OR last manual
    // rename / Tryhard / Chill template). Skip if there's no fallback recorded
    // (legacy rows pre-migration).
    const computed = computeAutoName(vc, record.ownerUserId, record.nameTemplate, record.userLimit)
    const newName = computed ?? record.fallbackName
    if (!newName) return

    // Don't rename if the name didn't actually change
    if (vc.name === newName) return

    lastRename.set(record.voiceChannelId, Date.now())
    await vc.setName(newName).catch(() => {})

    // Update text channel too
    const tc = await guild.channels.fetch(record.textChannelId).catch(() => null)
    const textName = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice-chat'
    if (tc?.isTextBased()) await (tc as any).setName(textName).catch(() => {})

    logger.info(`Presence auto-rename: vc=${record.voiceChannelId} → ${newName}`)
  })
}
