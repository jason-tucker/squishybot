import { ChannelType, PermissionFlagsBits, type Client, type Message } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { postOrUpdateSticky } from '../../services/voice/sticky'
import { getAutoThreadConfig, isAutoChannelText, isAutoThreadChannel } from '../../services/settings'
import { logger } from '../../services/logger'

const lastReposted = new Map<string, number>()
// 10 s caps a busy chat at ~6 sticky bumps/min instead of ~40 at the old
// 1.5 s window. The sticky is purely a discoverability aid (📋 Open Panel) —
// being a few seconds behind the bottom is fine and saves a lot of API churn.
const DEBOUNCE_MS = 10_000

/** Drop the sticky debounce entry when an auto-channel's text channel is
 * deleted; without this the Map leaks one entry per text channel forever. */
export function clearStickyDebounce(textChannelId: string): void {
  lastReposted.delete(textChannelId)
}

export function registerMessageCreate(client: Client): void {
  client.on('messageCreate', async (msg: Message) => {
    if (!msg.guildId) return
    if (msg.author.id === client.user!.id) return

    await maybeAutoThread(msg).catch(err => logger.error('Auto-thread failed', err))

    if (!isAutoChannelText(msg.channelId)) return

    const now = Date.now()
    const last = lastReposted.get(msg.channelId) ?? 0
    if (now - last < DEBOUNCE_MS) return
    lastReposted.set(msg.channelId, now)

    const [record] = await db.select().from(autoChannels)
      .where(eq(autoChannels.textChannelId, msg.channelId))
    if (!record) return
    await postOrUpdateSticky(client, record)
  })
}

async function maybeAutoThread(msg: Message): Promise<void> {
  if (msg.author.bot) return
  if (msg.system) return
  if (!isAutoThreadChannel(msg.channelId)) return
  // Only text and announcement channels support startThread on a parent message.
  // Forums/media channels create posts-as-threads natively; voice/stage text-in-voice doesn't.
  if (msg.channel.type !== ChannelType.GuildText && msg.channel.type !== ChannelType.GuildAnnouncement) return
  if (msg.hasThread) return  // someone already started one

  const channel = msg.channel
  const me = msg.guild?.members.me
  if (me && 'permissionsFor' in channel) {
    const perms = channel.permissionsFor(me)
    const need = msg.channel.type === ChannelType.GuildAnnouncement
      ? PermissionFlagsBits.CreatePublicThreads
      : PermissionFlagsBits.CreatePublicThreads
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(need)) {
      logger.warn(
        `Auto-thread skipped in #${(channel as any).name ?? msg.channelId}: bot missing ` +
        `${!perms?.has(PermissionFlagsBits.ViewChannel) ? 'VIEW_CHANNEL ' : ''}` +
        `${!perms?.has(need) ? 'CREATE_PUBLIC_THREADS' : ''}`.trim()
      )
      return
    }
  }

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
    if (err?.code === 50013 || err?.code === 50001) {
      logger.warn(`Auto-thread permission denied in #${(channel as any).name ?? msg.channelId} (code ${err.code}: ${err.message}) — skipping`)
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
