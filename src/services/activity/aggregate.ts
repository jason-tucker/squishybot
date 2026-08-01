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
import { classifyChannelKind, type ActivityChannelKind } from './channelKinds'

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
 *
 * Sub-second remainders are carried between segments and the un-credited
 * tail is exposed as `creditedTo` — callers advance their watermark to
 * `creditedTo` (not `to`) so repeated small rollups never systematically
 * truncate seconds away (~1.7%/session otherwise at a 30s tick cadence).
 */
export function splitIntoHourBuckets(from: Date, to: Date): {
  segments: { bucket: Date; seconds: number }[]
  creditedTo: Date
} {
  const segments: { bucket: Date; seconds: number }[] = []
  let cursor = from.getTime()
  const end = to.getTime()
  let creditedMs = 0
  let carry = 0
  while (cursor < end) {
    const bucketStart = Math.floor(cursor / HOUR_MS) * HOUR_MS
    const segmentEnd = Math.min(bucketStart + HOUR_MS, end)
    const exact = (segmentEnd - cursor) / 1000 + carry
    const seconds = Math.floor(exact)
    carry = exact - seconds
    if (seconds > 0) segments.push({ bucket: new Date(bucketStart), seconds })
    creditedMs += seconds * 1000
    cursor = segmentEnd
  }
  return { segments, creditedTo: new Date(from.getTime() + creditedMs) }
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
// Extended_Pictographic alone also matches text-presentation characters that
// ordinary prose contains constantly (\u2122 \u00A9 \u00AE \u203C \u2194 \u2714 \u2026). Those only count as
// emoji when the sequence is actually emoji-presented: base char defaults to
// emoji presentation, or the sequence carries VS16 / ZWJ / a skin tone.
const EMOJI_PRESENTATION_RE = /^\p{Emoji_Presentation}/u
const EMOJI_MODIFIER_RE = /\p{Emoji_Modifier}/u

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
    const seq = m[0]
    if (
      !EMOJI_PRESENTATION_RE.test(seq) &&
      !seq.includes('️') &&
      !seq.includes('‍') &&
      !EMOJI_MODIFIER_RE.test(seq)
    ) continue
    out.push({ emojiKey: seq, emojiName: null, custom: false })
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
  channelKind: ActivityChannelKind | null
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
    // Classified while the channel still exists — by flush time an auto
    // room's "delete now" teardown may already have emptied the registry.
    channelKind: classifyChannelKind(msg.channelId),
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
  if (delta.channelKind) existing.channelKind = delta.channelKind
}

export async function upsertMessageStats(row: MessageStatsDelta): Promise<boolean> {
  try {
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
        channelKind: row.channelKind ?? undefined,
      },
    })
    return true
  } catch (err) {
    logger.warn(`activity: message stats upsert failed: ${(err as Error).message}`)
    return false
  }
}

/** Drain a message-delta buffer into the DB and clear it. Rows whose upsert
 * fails are merged back into the buffer (a DB blip must not erase counts) —
 * merge, not set, because new activity may have landed mid-flush. */
export async function flushMessageBuffer(buffer: Map<string, MessageStatsDelta>): Promise<void> {
  if (buffer.size === 0) return
  const rows = Array.from(buffer.values())
  buffer.clear()
  for (const row of rows) {
    const ok = await upsertMessageStats(row)
    if (!ok) mergeMessageDelta(buffer, row)
  }
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

export async function upsertEmojiStats(row: EmojiStatsDelta): Promise<boolean> {
  try {
    await db.insert(activityEmojiStats).values(row).onConflictDoUpdate({
      target: [activityEmojiStats.userId, activityEmojiStats.emojiKey, activityEmojiStats.kind, activityEmojiStats.bucket],
      set: {
        count: sql`${activityEmojiStats.count} + ${row.count}`,
        emojiName: row.emojiName ?? undefined,
      },
    })
    return true
  } catch (err) {
    logger.warn(`activity: emoji stats upsert failed: ${(err as Error).message}`)
    return false
  }
}

/** Drain an emoji-delta buffer into the DB and clear it. Failed rows are
 * merged back — same reasoning as flushMessageBuffer. */
export async function flushEmojiBuffer(buffer: Map<string, EmojiStatsDelta>): Promise<void> {
  if (buffer.size === 0) return
  const rows = Array.from(buffer.values())
  buffer.clear()
  for (const row of rows) {
    const ok = await upsertEmojiStats(row)
    if (!ok) mergeEmojiDelta(buffer, row)
  }
}
