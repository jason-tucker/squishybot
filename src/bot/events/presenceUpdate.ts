import type { Client, Presence } from 'discord.js'
import { ActivityType } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { logger } from '../../services/logger'
import { getSmartGameName } from '../../utils/richPresence'

// Debounce: don't rename more than once per 10 minutes per channel (Discord rate limit)
const lastRename = new Map<string, number>()
const RENAME_COOLDOWN_MS = 10 * 60 * 1000

export function registerPresenceUpdate(client: Client): void {
  client.on('presenceUpdate', async (_old: Presence | null, newPresence: Presence) => {
    if (newPresence.guild?.id !== env.GUILD_ID) return
    if (!newPresence.userId) return

    // Find any auto channel owned by this user
    const [record] = await db.select().from(autoChannels)
      .where(eq(autoChannels.ownerUserId, newPresence.userId))

    if (!record) return
    if (!record.autoNameEnabled) return
    if (record.nameTemplate !== 'auto' && record.nameTemplate !== 'counter' && record.autoNameEnabled) {
      // Only auto-rename if explicitly using an auto template
      if (record.nameTemplate !== 'auto') return
    }

    // Rate limit check
    const lastTime = lastRename.get(record.voiceChannelId) ?? 0
    if (Date.now() - lastTime < RENAME_COOLDOWN_MS) return

    const game = newPresence.activities.find(a => a.type === ActivityType.Playing)
    if (!game) return // only update when a game starts, not when one ends

    const guild = client.guilds.cache.get(env.GUILD_ID)
    if (!guild) return

    const vc = await guild.channels.fetch(record.voiceChannelId).catch(() => null)
    if (!vc?.isVoiceBased()) return

    const baseName = getSmartGameName(game)

    let newName: string
    if (record.nameTemplate === 'counter') {
      const limit = record.userLimit > 0 ? record.userLimit : 4
      newName = `${baseName} [${vc.members.size}/${limit}]`
    } else {
      newName = baseName
    }

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
