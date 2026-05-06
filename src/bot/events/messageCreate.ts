import { ChannelType, type Client, type Message } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { postOrUpdateSticky } from '../../services/voice/sticky'
import { getAutoThreadConfig, isAutoThreadChannel } from '../../services/settings'
import { logger } from '../../services/logger'

// Per-channel debounce so we don't churn on rapid-fire chat
const lastReposted = new Map<string, number>()
const DEBOUNCE_MS = 1500

export function registerMessageCreate(client: Client): void {
  client.on('messageCreate', async (msg: Message) => {
    if (!msg.guildId) return
    if (msg.author.id === client.user!.id) return

    // Auto-thread first — orthogonal to the auto-channel sticky flow.
    await maybeAutoThread(msg).catch(err =>
      logger.error('Auto-thread failed', err)
    )

    // Auto-channel sticky panel re-post (only fires inside an auto-channel text channel).
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

async function maybeAutoThread(msg: Message): Promise<void> {
  if (msg.author.bot) return
  if (msg.system) return
  if (!isAutoThreadChannel(msg.channelId)) return
  if (msg.channel.type !== ChannelType.GuildText) return  // skip threads, voice text, etc.
  if (msg.hasThread) return  // someone already started one

  const cfg = getAutoThreadConfig(msg.channelId)
  const name = formatThreadName(msg, cfg?.nameTemplate ?? null).slice(0, 100)
  const archive = (cfg?.archiveDuration ?? 1440) as 60 | 1440 | 4320 | 10080

  try {
    await msg.startThread({ name, autoArchiveDuration: archive })
  } catch (err: any) {
    if (err?.code === 429 || err?.status === 429) {
      logger.warn(`Auto-thread rate-limited in #${msg.channelId} — skipping`)
      return
    }
    throw err
  }
}

function formatThreadName(msg: Message, template: string | null): string {
  const author = msg.member?.displayName ?? msg.author.displayName ?? msg.author.username
  const firstLine = (msg.content ?? '').split('\n').map(s => s.trim()).find(Boolean) ?? ''
  const content = firstLine.slice(0, 80)

  if (template) {
    return template
      .replace(/\{author\}/g, author)
      .replace(/\{content\}/g, content || `${author}'s post`)
  }
  return content ? `${author} — ${content}` : `${author}'s post`
}
