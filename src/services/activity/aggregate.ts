/**
 * Shared content-parsing + additive-upsert helpers for the Activity Stats
 * feature. Used by BOTH the live tracker (./tracker.ts) and the history
 * backfill (./backfill.ts) so message/emoji counting can never drift between
 * the two code paths — every counting rule lives here exactly once.
 *
 * No message content is ever persisted anywhere in this module — only the
 * derived counts (word/char counts, attachment/mention/reply counts, and
 * parsed emoji keys) ever reach the DB.
 */
import { sql } from 'drizzle-orm'
import type { Message } from 'discord.js'
import { db } from '../../db/client'
import { activityEmojiStats, activityMessageStats } from '../../db/schema'
import { logger } from '../logger'

const HOUR_MS = 3_600_000

// ---------------------------------------------------------------------------
// Hour bucketing
// ---------------------------------------------------------------------------

/** Truncate a timestamp (ms epoch or Date) down to the start of its UTC hour. */
export function hourBucket(t: number | Date): Date {
  const ms = t instanceof Date ? t.getTime() : t
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS)
}

/**
 * Split a [from, to) interval into per-hour-bucket second counts. Used by
 * the tracker's voice/game session rollup so a session spanning a UTC hour
 * boundary attributes seconds to every bucket it overlaps instead of dumping
 * the whole interval into whichever bucket `from` happens to land in.
 */
export function splitIntoHourBuckets(from: Date, to: Date): { bucket: Date; seconds: number }[] {
  const out: { bucket: Date; seconds: number }[] = []
  let cursor = from.getTime()
  const end = to.getTime()
  while (cursor < end) {
    const bucketStart = Math.floor(cursor / HOUR_MS) * HOUR_MS
    const segmentEnd = Math.min(bucketStart + HOUR_MS, end)
    const seconds = Math.floor((segmentEnd - cursor) / 1000)
    if (seconds > 0) out.push({ bucket: new Date(bucketStart), seconds })
    cursor = segmentEnd
  }
  return out
}

// ---------------------------------------------------------------------------
// Emoji content parsing — custom <a?:name:id> + unicode Extended_Pictographic
// sequences. ZWJ-joined / VS16-suffixed / skin-tone-modified sequences merge
// into a single emojiKey (e.g. a family emoji or a toned 👍) instead of
// over-counting each code point separately.
// ---------------------------------------------------------------------------

export interface ParsedEmoji {
  emojiKey: string
  emojiName: string | null
  custom: boolean
}

const CUSTOM_EMOJI_RE = /<a?:(\w+):(\d+)>/g
// One Extended_Pictographic char, an optional VS16 (U+FE0F), then any number
// of either a ZWJ (U+200D)-joined Extended_Pictographic (+ optional VS16) or
// a skin-tone modifier — this is what merges e.g. a 4-person ZWJ family or a
// toned 👍 into one sequence instead of one match per code point. Escapes
// used instead of the literal invisible characters so the source stays
// diff-/review-safe.
const UNICODE_EMOJI_RE = /\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?|\p{Emoji_Modifier})*/gu

/** Parse every emoji occurrence out of message content. Never returns or
 * stores the surrounding text — only the emoji key/name/custom triples. */
export function parseEmojis(content: string | null | undefined): ParsedEmoji[] {
  if (!content) return []
  const out: ParsedEmoji[] = []
  for (const m of content.matchAll(CUSTOM_EMOJI_RE)) {
    out.push({ emojiKey: m[2], emojiName: m[1], custom: true })
  }
  // Strip custom-emoji spans before the unicode pass so nothing inside
  // <a:name:id> syntax can ever be picked up as a unicode sequence too.
  const stripped = content.replace(CUSTOM_EMOJI_RE, ' ')
  for (const m of stripped.matchAll(UNICODE_EMOJI_RE)) {
    out.push({ emojiKey: m[0], emojiName: null, custom: false })
  }
  return out
}

// ---------------------------------------------------------------------------
// Message stats — delta computation, buffer merge, additive upsert
// ---------------------------------------------------------------------------

export interface MessageStatsDelta {
  guildId: string
  userId: string
  channelId: string
  channelName: string | null
  bucket: Date
  messageCount: number
  wordCount: number
  charCount: number
  attachmentCount: number
  mentionCount: number
  replyCount: number
}

/** Derive one message's stat contribution. Counts only — the message's own
 * `content` never leaves this function. */
export function computeMessageDelta(msg: Message): MessageStatsDelta {
  const content = msg.content ?? ''
  const words = content.split(/\s+/).filter(Boolean)
  return {
    guildId: msg.guildId!,
    userId: msg.author.id,
    channelId: msg.channelId,
    channelName: 'name' in msg.channel ? (msg.channel.name ?? null) : null,
    bucket: hourBucket(msg.createdTimestamp),
    messageCount: 1,
    wordCount: words.length,
    charCount: content.length,
    attachmentCount: msg.attachments.size,
    mentionCount: msg.mentions.users.size + msg.mentions.roles.size,
    replyCount: msg.reference != null ? 1 : 0,
  }
}

/** Merge a delta into a buffer keyed by (userId, channelId, bucket). Shared
 * by the tracker's 30s flush and backfill's per-batch flush so both drain
 * through the exact same additive-upsert path below. */
export function mergeMessageDelta(buffer: Map<string, MessageStatsDelta>, delta: MessageStatsDelta): void {
  const key = `${delta.userId}|${delta.channelId}|${delta.bucket.getTime()}`
  const existing = buffer.get(key)
  if (!existing) {
    buffer.set(key, { ...delta })
    return
  }
  existing.messageCount += delta.messageCount
  existing.wordCount += delta.wordCount
  existing.charCount += delta.charCount
  existing.attachmentCount += delta.attachmentCount
  existing.mentionCount += delta.mentionCount
  existing.replyCount += delta.replyCount
  if (delta.channelName) existing.channelName = delta.channelName
}

export async function upsertMessageStats(row: MessageStatsDelta): Promise<void> {
  await db.insert(activityMessageStats).values(row).onConflictDoUpdate({
    target: [activityMessageStats.userId, activityMessageStats.channelId, activityMessageStats.bucket],
    set: {
      messageCount: sql`${activityMessageStats.messageCount} + ${row.messageCount}`,
      wordCount: sql`${activityMessageStats.wordCount} + ${row.wordCount}`,
      charCount: sql`${activityMessageStats.charCount} + ${row.charCount}`,
      attachmentCount: sql`${activityMessageStats.attachmentCount} + ${row.attachmentCount}`,
      mentionCount: sql`${activityMessageStats.mentionCount} + ${row.mentionCount}`,
      replyCount: sql`${activityMessageStats.replyCount} + ${row.replyCount}`,
      channelName: row.channelName ?? undefined,
    },
  }).catch(err => logger.warn(`activity: message stats upsert failed: ${(err as Error).message}`))
}

/** Drain a message-delta buffer into the DB and clear it. */
export async function flushMessageBuffer(buffer: Map<string, MessageStatsDelta>): Promise<void> {
  if (buffer.size === 0) return
  const rows = Array.from(buffer.values())
  buffer.clear()
  for (const row of rows) await upsertMessageStats(row)
}

// ---------------------------------------------------------------------------
// Emoji stats — buffer merge, additive upsert
// ---------------------------------------------------------------------------

export interface EmojiStatsDelta {
  guildId: string
  userId: string
  emojiKey: string
  emojiName: string | null
  custom: boolean
  kind: 'message' | 'reaction_given' | 'reaction_received'
  bucket: Date
  count: number
}

/** Merge a delta into a buffer keyed by (userId, emojiKey, kind, bucket). */
export function mergeEmojiDelta(buffer: Map<string, EmojiStatsDelta>, delta: EmojiStatsDelta): void {
  const key = `${delta.userId}|${delta.emojiKey}|${delta.kind}|${delta.bucket.getTime()}`
  const existing = buffer.get(key)
  if (!existing) {
    buffer.set(key, { ...delta })
    return
  }
  existing.count += delta.count
  if (delta.emojiName) existing.emojiName = delta.emojiName
}

export async function upsertEmojiStats(row: EmojiStatsDelta): Promise<void> {
  await db.insert(activityEmojiStats).values(row).onConflictDoUpdate({
    target: [activityEmojiStats.userId, activityEmojiStats.emojiKey, activityEmojiStats.kind, activityEmojiStats.bucket],
    set: {
      count: sql`${activityEmojiStats.count} + ${row.count}`,
      emojiName: row.emojiName ?? undefined,
    },
  }).catch(err => logger.warn(`activity: emoji stats upsert failed: ${(err as Error).message}`))
}

/** Drain an emoji-delta buffer into the DB and clear it. */
export async function flushEmojiBuffer(buffer: Map<string, EmojiStatsDelta>): Promise<void> {
  if (buffer.size === 0) return
  const rows = Array.from(buffer.values())
  buffer.clear()
  for (const row of rows) await upsertEmojiStats(row)
}
