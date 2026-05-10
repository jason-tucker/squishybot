import type { Client, TextChannel } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { buildStickyPayload } from '../../embeds/voiceSticky'
import type { AutoChannelRecord } from '../../types/voice'
import { logger } from '../logger'

export async function postOrUpdateSticky(client: Client, record: AutoChannelRecord): Promise<void> {
  // Prefer the cached channel — Guilds + GuildMessages intents keep the
  // text channel cache hot, so the previous fetch round-trip on every
  // chat message was wasted.
  const guild = client.guilds.cache.get(record.guildId) ?? client.guilds.cache.first()
  if (!guild) return
  const cached = guild.channels.cache.get(record.textChannelId) as TextChannel | undefined
  const textChannel = cached
    ?? (await guild.channels.fetch(record.textChannelId).catch(() => null) as TextChannel | null)
  if (!textChannel?.isTextBased()) return

  // Already at the bottom — nothing to do. lastMessageId is populated from
  // the gateway as messages arrive (no API call), so this check is free.
  if (record.stickyMsgId && textChannel.lastMessageId === record.stickyMsgId) return

  // Delete the previous sticky so the new one stays at the bottom
  if (record.stickyMsgId) {
    const old = await textChannel.messages.fetch(record.stickyMsgId).catch(() => null)
    if (old) await old.delete().catch(() => {})
  }

  const payload = buildStickyPayload(record.voiceChannelId)
  const msg = await textChannel.send(payload as any).catch(err => {
    logger.warn('Failed to post sticky:', err)
    return null
  })
  if (!msg) return

  await db.update(autoChannels)
    .set({ stickyMsgId: msg.id })
    .where(eq(autoChannels.voiceChannelId, record.voiceChannelId))
    .catch(() => {})
}
