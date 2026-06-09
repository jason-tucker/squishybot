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
import type { Client, GuildTextBasedChannel } from 'discord.js'
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
import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000  // 30 minutes
const FETCH_TIMEOUT_MS = 15_000
/** Max redirect hops to follow manually (each re-validated against the SSRF allowlist). */
const MAX_REDIRECTS = 5
/**
 * Hard cap on RSS body size — typical feeds are <100 KB. 5 MB protects the
 * bot from a hostile/misconfigured feed serving multi-GB responses (memory
 * exhaustion).
 */
const MAX_FEED_BYTES = 5 * 1024 * 1024

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
  // Feature flag (#33).
  const { getBoolSetting } = await import('../settings')
  if (!getBoolSetting('feature.social_poller', true)) return
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

  // Apply per-feed throttle (#29). 0 = post only the single latest new item.
  // Any other value caps the number of items posted this round; the rest get
  // their `lastSeenId` bumped to the latest so they're not replayed but also
  // don't flood the channel mid-life.
  const max = feed.maxItemsPerPoll
  const sliced = max === 0 ? fresh.slice(0, 1) : fresh.slice(0, max)

  // Post oldest-first so chronology in the channel matches the source.
  const channel = await resolveChannel(client, feed.channelId)
  if (!channel) {
    throw new Error(`channel ${feed.channelId} unavailable or not text-based`)
  }
  for (const it of [...sliced].reverse()) {
    await channel.send(buildSocialPostPayload(feed, it) as any).catch((err: unknown) => {
      logger.warn(`Failed to send social post for "${feed.label}" item=${it.guid}:`, err)
    })
  }
  // Mark the newest fresh item as seen even if it wasn't posted — otherwise
  // the throttled-off items would resurface on every subsequent poll.
  await markSocialFeedSeen(feed.id, fresh[0].guid)
}

export async function fetchAndParse(url: string): Promise<RssItem[]> {
  // SECURITY (M1): follow redirects MANUALLY and re-run the SSRF allowlist on
  // every hop. With `redirect: 'follow'`, fetch/undici chases 3xx internally
  // without re-invoking our guard, so a public URL could 302 → http://localhost
  // / 169.254.169.254 / the docker db|redis host and bypass the check entirely.
  let current = url
  let res: Response | null = null
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeOutboundUrl(current)
    res = await fetch(current, {
      headers: { 'User-Agent': 'squishybot social poller (+https://github.com/jason-tucker/squishybot)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) break  // malformed redirect — treat the 3xx as terminal (errors below)
      // Resolve relative Location against the current URL, then re-validate at
      // the top of the next iteration before connecting.
      current = new URL(loc, current).toString()
      continue
    }
    break
  }
  if (!res) throw new Error(`no response from ${url}`)
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${current}`)
  const xml = await readBoundedText(res, MAX_FEED_BYTES)
  return parseFeed(xml)
}

/**
 * Reject URLs whose hostname resolves to a non-public address. Defends against
 * a compromised / malicious sudo wiring an RSS feed URL that points at an
 * internal service (`localhost`, the docker DB, cloud metadata at
 * 169.254.169.254, RFC1918 ranges) and using the bot to probe it. Note: this
 * guard is best-effort against TOCTOU — a hostname could resolve to public on
 * pre-flight then private on the actual connect (DNS rebinding). For our
 * threat model (rogue sudo, not network-level attacker), pre-flight DNS is
 * the right cost/benefit point.
 */
async function assertSafeOutboundUrl(url: string): Promise<void> {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error(`invalid URL: ${url}`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`refused non-http(s) URL: ${parsed.protocol}`)
  }
  const hostname = parsed.hostname
  if (!hostname) throw new Error('URL missing hostname')
  // Resolve all answers — a hostname with mixed public/private records
  // (rare, but real for split-horizon DNS) should be rejected.
  const literal = isIP(hostname)
  const addrs = literal
    ? [{ address: hostname, family: literal }]
    : await dns.lookup(hostname, { all: true }).catch(() => {
        throw new Error(`DNS lookup failed for ${hostname}`)
      })
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new Error(`refused outbound to private/loopback ${a.address} for ${hostname}`)
    }
  }
}

/** RFC1918 + loopback + link-local + CGNAT + IPv6 equivalents. */
function isPrivateAddress(ip: string): boolean {
  if (ip === '0.0.0.0' || ip === '::' || ip === '::1') return true
  if (ip.startsWith('127.')) return true
  if (ip.startsWith('10.')) return true
  if (ip.startsWith('192.168.')) return true
  if (ip.startsWith('169.254.')) return true  // link-local incl. cloud metadata
  if (ip.startsWith('100.')) {                // CGNAT 100.64.0.0/10
    const second = parseInt(ip.split('.')[1] ?? '', 10)
    if (second >= 64 && second <= 127) return true
  }
  if (ip.startsWith('172.')) {                // 172.16.0.0/12
    const second = parseInt(ip.split('.')[1] ?? '', 10)
    if (second >= 16 && second <= 31) return true
  }
  // IPv6 — match unique-local (fc00::/7), link-local (fe80::/10), v4-mapped private
  const lower = ip.toLowerCase()
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7))
  return false
}

/**
 * Stream the response body, hard-capping bytes read. Falls back to
 * res.text() if the body isn't a stream (test mocks etc.).
 */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return res.text()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`feed exceeded ${maxBytes} byte cap`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }
  // Concatenate into one buffer, then decode once.
  const buf = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { buf.set(c, offset); offset += c.byteLength }
  return new TextDecoder('utf-8').decode(buf)
}

async function resolveChannel(client: Client, channelId: string): Promise<GuildTextBasedChannel | null> {
  const cached = client.channels.cache.get(channelId)
  const ch = cached ?? await client.channels.fetch(channelId).catch(() => null)
  if (!ch || !ch.isTextBased() || ch.isDMBased()) return null
  return ch as GuildTextBasedChannel
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

  // RSS items come from third-party aggregators we don't control. Defensively
  // gate every URL we emit to http/https only, so a malicious feed can't slip
  // a `javascript:` / `data:` link into a Link button or media preview even
  // if Discord's own validation ever drifted.
  const safeImageUrl = isSafeHttpUrl(item.imageUrl) ? item.imageUrl! : null
  if (safeImageUrl) {
    container.addSeparatorComponents(sep())
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems([{ media: { url: safeImageUrl } }])
    )
  }

  const components: any[] = [container]
  const safeLink = isSafeHttpUrl(item.link) ? item.link! : null
  if (safeLink) {
    const linkRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel(`View on ${platform}`)
        .setStyle(ButtonStyle.Link)
        .setURL(safeLink)
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

function isSafeHttpUrl(u: string | null | undefined): boolean {
  if (!u) return false
  try {
    const parsed = new URL(u)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
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
