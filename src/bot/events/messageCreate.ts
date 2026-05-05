import type { Client, Message } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { postOrUpdateSticky } from '../../services/voice/sticky'

// Per-channel debounce so we don't churn on rapid-fire chat
const lastReposted = new Map<string, number>()
const DEBOUNCE_MS = 1500

export function registerMessageCreate(client: Client): void {
  client.on('messageCreate', async (msg: Message) => {
    if (!msg.guildId) return
    if (msg.author.id === client.user!.id) return

    const [record] = await db.select().from(autoChannels)
      .where(eq(autoChannels.textChannelId, msg.channelId))
    if (!record) return

    const now = Date.now()
    const last = lastReposted.get(msg.channelId) ?? 0
    if (now - last < DEBOUNCE_MS) return
    lastReposted.set(msg.channelId, now)

    await postOrUpdateSticky(client, record)
  })
}
