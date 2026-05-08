/**
 * In-memory cache + DB CRUD for the `social_feeds` table.
 *
 * Mirrors the pattern in `services/settings.ts`: load all rows on startup,
 * keep them in a Map keyed by feed id, and have callers read synchronously
 * from the cache. Writes hit the DB and update the cache.
 */
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { socialFeeds } from '../db/schema'

export interface SocialFeed {
  id: string
  guildId: string
  label: string
  sourceUrl: string
  channelId: string
  enabled: boolean
  lastSeenId: string | null
  lastPolledAt: Date | null
  lastError: string | null
  createdByDiscordId: string | null
  createdAt: Date
}

const cache = new Map<string, SocialFeed>()

export async function loadSocialFeeds(): Promise<void> {
  cache.clear()
  const rows = await db.select().from(socialFeeds).catch(() => [])
  for (const r of rows) cache.set(r.id, toSocialFeed(r))
}

function toSocialFeed(r: typeof socialFeeds.$inferSelect): SocialFeed {
  return {
    id: r.id,
    guildId: r.guildId,
    label: r.label,
    sourceUrl: r.sourceUrl,
    channelId: r.channelId,
    enabled: r.enabled,
    lastSeenId: r.lastSeenId,
    lastPolledAt: r.lastPolledAt,
    lastError: r.lastError,
    createdByDiscordId: r.createdByDiscordId,
    createdAt: r.createdAt,
  }
}

export function listSocialFeeds(): SocialFeed[] {
  return Array.from(cache.values()).sort((a, b) => a.label.localeCompare(b.label))
}

export function getSocialFeed(id: string): SocialFeed | null {
  return cache.get(id) ?? null
}

export async function addSocialFeed(input: {
  guildId: string
  label: string
  sourceUrl: string
  channelId: string
  createdByDiscordId?: string | null
  /** Seed lastSeenId so the existing backlog isn't replayed on first poll. */
  seedLastSeenId?: string | null
}): Promise<SocialFeed> {
  const [row] = await db.insert(socialFeeds)
    .values({
      guildId: input.guildId,
      label: input.label,
      sourceUrl: input.sourceUrl,
      channelId: input.channelId,
      lastSeenId: input.seedLastSeenId ?? null,
      createdByDiscordId: input.createdByDiscordId ?? null,
    })
    .returning()
  const feed = toSocialFeed(row)
  cache.set(feed.id, feed)
  return feed
}

export async function removeSocialFeed(id: string): Promise<void> {
  await db.delete(socialFeeds).where(eq(socialFeeds.id, id))
  cache.delete(id)
}

export async function setSocialFeedEnabled(id: string, enabled: boolean): Promise<void> {
  await db.update(socialFeeds).set({ enabled }).where(eq(socialFeeds.id, id))
  const cur = cache.get(id)
  if (cur) cache.set(id, { ...cur, enabled })
}

export async function setSocialFeedChannel(id: string, channelId: string): Promise<void> {
  await db.update(socialFeeds).set({ channelId }).where(eq(socialFeeds.id, id))
  const cur = cache.get(id)
  if (cur) cache.set(id, { ...cur, channelId })
}

export async function markSocialFeedSeen(id: string, lastSeenId: string): Promise<void> {
  const polledAt = new Date()
  await db.update(socialFeeds)
    .set({ lastSeenId, lastPolledAt: polledAt, lastError: null })
    .where(eq(socialFeeds.id, id))
  const cur = cache.get(id)
  if (cur) cache.set(id, { ...cur, lastSeenId, lastPolledAt: polledAt, lastError: null })
}

export async function markSocialFeedPollSuccess(id: string): Promise<void> {
  const polledAt = new Date()
  await db.update(socialFeeds)
    .set({ lastPolledAt: polledAt, lastError: null })
    .where(eq(socialFeeds.id, id))
  const cur = cache.get(id)
  if (cur) cache.set(id, { ...cur, lastPolledAt: polledAt, lastError: null })
}

export async function markSocialFeedError(id: string, error: string): Promise<void> {
  const polledAt = new Date()
  const trimmed = error.length > 500 ? error.slice(0, 499) + '…' : error
  await db.update(socialFeeds)
    .set({ lastPolledAt: polledAt, lastError: trimmed })
    .where(eq(socialFeeds.id, id))
  const cur = cache.get(id)
  if (cur) cache.set(id, { ...cur, lastPolledAt: polledAt, lastError: trimmed })
}
