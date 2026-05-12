import { ChannelType, PermissionFlagsBits, type Client, type Message, type PartialMessage } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { postOrUpdateSticky } from '../../services/voice/sticky'
import { getAutoChannelTextFor, getAutoThreadConfig, getBoolSetting, isAutoChannelText, isAutoChannelVoice, isAutoThreadChannel } from '../../services/settings'
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
    await maybeNudgeOutOfVoiceChat(msg).catch(err => logger.error('Voice-chat nudge failed', err))

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

  // Link embeds are resolved a beat after the message lands, firing a
  // messageUpdate. Re-check so URL-only posts in auto-thread channels still
  // get a thread once their preview shows up.
  client.on('messageUpdate', async (_old, updated: Message | PartialMessage) => {
    if (updated.partial) return  // we only enabled GuildMember partials, so this is rare
    if (!updated.guildId) return
    if (updated.author?.id === client.user!.id) return
    if (updated.embeds.length === 0) return  // not the embed-resolution update we care about
    await maybeAutoThread(updated as Message).catch(err => logger.error('Auto-thread (update) failed', err))
  })
}

async function maybeAutoThread(msg: Message): Promise<void> {
  if (msg.author.bot) return
  if (msg.system) return
  // Feature flag (#33).
  if (!getBoolSetting('feature.auto_threads', true)) return
  if (!isAutoThreadChannel(msg.channelId)) return
  // Only text and announcement channels support startThread on a parent message.
  // Forums/media channels create posts-as-threads natively; voice/stage text-in-voice doesn't.
  if (msg.channel.type !== ChannelType.GuildText && msg.channel.type !== ChannelType.GuildAnnouncement) return
  if (msg.hasThread) return  // someone already started one
  // Only thread messages with media — uploaded files or link embeds.
  // Embeds populate asynchronously, so plain-text posts with a URL are
  // re-checked in messageUpdate once Discord resolves the embed.
  if (msg.attachments.size === 0 && msg.embeds.length === 0) return

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

// Per-(channel, user) cooldown so the bot doesn't spam the nudge if someone
// fires off five messages in a row. The voice channel chat is low-traffic by
// design, so a long window is fine.
const NUDGE_COOLDOWN_MS = 5 * 60_000  // 5 minutes
const lastNudged = new Map<string, number>()  // key = `${voiceChannelId}:${userId}`

async function maybeNudgeOutOfVoiceChat(msg: Message): Promise<void> {
  if (msg.author.bot) return
  if (msg.system) return
  if (msg.channel.type !== ChannelType.GuildVoice) return  // only the built-in voice-channel text chat
  if (!isAutoChannelVoice(msg.channelId)) return
  if (!getBoolSetting('voice.no_voice_chat_messages')) return

  const cooldownKey = `${msg.channelId}:${msg.author.id}`
  const now = Date.now()
  const last = lastNudged.get(cooldownKey) ?? 0
  if (now - last < NUDGE_COOLDOWN_MS) return
  lastNudged.set(cooldownKey, now)

  const textChannelId = getAutoChannelTextFor(msg.channelId)
  const pointer = textChannelId ? `<#${textChannelId}>` : 'the attached text channel'
  await msg.reply({
    content: `Heads up — this voice channel has its own text channel just below (${pointer}). Mind moving the convo there?`,
    allowedMentions: { parse: [], repliedUser: false },
  }).catch(err => logger.warn(`Voice-chat nudge reply failed in vc=${msg.channelId}: ${err?.message ?? err}`))
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
