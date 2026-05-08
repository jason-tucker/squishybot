/**
 * Polls every enabled `social_feeds` row on a fixed interval, fetches the RSS,
 * dedupes against `last_seen_id`, posts new items oldest-first into the feed's
 * configured channel, then advances `last_seen_id` to the newest item.
 *
 * Cadence is configurable via `bot_settings.social.poll_interval_ms` and
 * defaults to 30 minutes — well under the typical free-tier RSS aggregator
 * refresh cadence (~24h) but enough granularity that "they just posted" lands
 * within an hour of the aggregator picking it up.
 */
import type { Client, TextBasedChannel } from 'discord.js'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js'
import { logger } from '../logger'
import { settingOrNumber } from '../settings'
import {
  type SocialFeed,
  listSocialFeeds,
  markSocialFeedError,
  markSocialFeedPollSuccess,
  markSocialFeedSeen,
} from '../socialFeeds'
import { parseFeed, stripHtml, type RssItem } from './rssParser'
import { sep } from '../../utils/cv2'

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000  // 30 minutes
const FETCH_TIMEOUT_MS = 15_000

let timer: NodeJS.Timeout | null = null

export function startSocialPoller(client: Client): void {
  if (timer) clearInterval(timer)
  const interval = Math.max(60_000, settingOrNumber('social.poll_interval_ms', DEFAULT_INTERVAL_MS))
  // Run once shortly after boot so freshly-added feeds publish quickly, then on
  // the configured cadence. A 10 s warmup avoids racing with reconciler.
  setTimeout(() => { void runPoll(client) }, 10_000)
  timer = setInterval(() => { void runPoll(client) }, interval)
  logger.info(`Social poller started — interval=${Math.round(interval / 1000)}s`)
}

export async function runPoll(client: Client): Promise<void> {
  const feeds = listSocialFeeds().filter(f => f.enabled)
  for (const feed of feeds) {
    try {
      await pollFeed(client, feed)
    } catch (err) {
      logger.warn(`Social poll failed for "${feed.label}":`, err)
      await markSocialFeedError(feed.id, (err as Error).message ?? String(err)).catch(() => {})
    }
  }
}

async function pollFeed(client: Client, feed: SocialFeed): Promise<void> {
  const items = await fetchAndParse(feed.sourceUrl)
  if (items.length === 0) {
    await markSocialFeedPollSuccess(feed.id)
    return
  }

  // First poll for this feed (no lastSeenId) — seed with the newest item
  // without posting anything. Avoids dumping the entire backlog into the
  // channel the first time an admin adds a feed.
  if (!feed.lastSeenId) {
    await markSocialFeedSeen(feed.id, items[0].guid)
    return
  }

  // Find new items: everything before the previously-seen GUID. Feeds emit
  // newest-first, so we walk from the top until we hit a known GUID.
  const fresh: RssItem[] = []
  for (const it of items) {
    if (it.guid === feed.lastSeenId) break
    fresh.push(it)
  }
  if (fresh.length === 0) {
    await markSocialFeedPollSuccess(feed.id)
    return
  }

  // Post oldest-first so chronology in the channel matches the source.
  const channel = await resolveChannel(client, feed.channelId)
  if (!channel) {
    throw new Error(`channel ${feed.channelId} unavailable or not text-based`)
  }
  for (const it of [...fresh].reverse()) {
    await channel.send(buildSocialPostPayload(feed, it) as any).catch(err => {
      logger.warn(`Failed to send social post for "${feed.label}" item=${it.guid}:`, err)
    })
  }
  await markSocialFeedSeen(feed.id, fresh[0].guid)
}

export async function fetchAndParse(url: string): Promise<RssItem[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'squishybot social poller (+https://github.com/jason-tucker/squishybot)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  const xml = await res.text()
  return parseFeed(xml)
}

async function resolveChannel(client: Client, channelId: string): Promise<TextBasedChannel | null> {
  const cached = client.channels.cache.get(channelId)
  const ch = cached ?? await client.channels.fetch(channelId).catch(() => null)
  if (!ch || !ch.isTextBased() || ch.isDMBased()) return null
  return ch
}

/**
 * Components V2 message: header line, optional image preview, description
 * preview, and a "View on {platform}" link button.
 */
export function buildSocialPostPayload(feed: SocialFeed, item: RssItem) {
  const platform = derivePlatform(item.link ?? feed.sourceUrl)
  const headerLine = `**${feed.label}** · new post${item.pubDate ? ` · <t:${Math.floor(item.pubDate.getTime() / 1000)}:R>` : ''}`
  const titleLine = item.title ? `\n**${item.title}**` : ''
  const description = stripHtml(item.description, 600)
  const body = description ? `\n${description}` : ''

  const container = new ContainerBuilder()
    .setAccentColor(platformAccent(platform))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLine + titleLine + body))

  if (item.imageUrl) {
    container.addSeparatorComponents(sep())
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems([{ media: { url: item.imageUrl } }])
    )
  }

  const components: any[] = [container]
  if (item.link) {
    const linkRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel(`View on ${platform}`)
        .setStyle(ButtonStyle.Link)
        .setURL(item.link)
    )
    components.push(linkRow)
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components,
    // Belt-and-braces — feed text could contain @mentions or @everyone tokens.
    allowedMentions: { parse: [] },
  }
}

function derivePlatform(url: string): string {
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase() } catch { return '' }
  })()
  if (host.includes('instagram')) return 'Instagram'
  if (host.includes('twitter') || host.includes('x.com')) return 'X'
  if (host.includes('youtube') || host.includes('youtu.be')) return 'YouTube'
  if (host.includes('mastodon') || host.includes('mas.to') || host.includes('hachyderm')) return 'Mastodon'
  if (host.includes('bsky')) return 'Bluesky'
  if (host.includes('tiktok')) return 'TikTok'
  return 'Source'
}

function platformAccent(platform: string): number {
  switch (platform) {
    case 'Instagram': return 0xe1306c
    case 'X':         return 0x1da1f2
    case 'YouTube':   return 0xff0000
    case 'Mastodon':  return 0x6364ff
    case 'Bluesky':   return 0x1185fe
    case 'TikTok':    return 0xfe2c55
    default:          return 0x5865f2
  }
}
