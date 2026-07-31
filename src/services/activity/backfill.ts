/**
 * Activity Stats — rate-limited history backfill.
 *
 * Walks every trackable text/announcement channel BACKWARDS (`before:
 * cursor`) starting from a synthetic snowflake at `stats.enabled_at`. Live
 * tracking (./tracker.ts) only ever counts messages from that point forward,
 * so backfill only ever sees messages OLDER than what live tracking has
 * already counted — the two can never double-count the same message.
 *
 * Progress is DB-backed (`activity_backfill_progress`, one row per channel)
 * so the panel can render progress and a bot restart resumes where it left
 * off instead of restarting every channel from scratch.
 */
import { ChannelType, PermissionFlagsBits } from 'discord.js'
import type { Client, Guild, TextChannel } from 'discord.js'
import { eq, lt, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { activityBackfillProgress, activityEmojiStats, activityMessageStats } from '../../db/schema'
import { env } from '../../config/env'
import { logger } from '../logger'
import { getBoolSetting, getSetting, settingOrNumber } from '../settings'
import {
  computeMessageDelta,
  flushEmojiBuffer,
  flushMessageBuffer,
  mergeEmojiDelta,
  mergeMessageDelta,
  parseEmojis,
  type EmojiStatsDelta,
  type MessageStatsDelta,
} from './aggregate'

const RECHECK_DELAY_MS = 15_000
const DEFAULT_BATCH_DELAY_MS = 3000
const BATCH_SIZE = 100
// 'error' rows are requeued to 'pending' after this cooldown so one
// transient fetch failure doesn't permanently drop a channel's history.
const ERROR_RETRY_MS = 10 * 60_000
// Inverse of the snowflake math in archive.ts:114
// (Number((BigInt(id) >> 22n) + 1420070400000n)).
const DISCORD_EPOCH_MS = 1420070400000

let started = false
let backfillTimer: ReturnType<typeof setTimeout> | null = null
let currentChannelId: string | null = null

export function startActivityBackfill(client: Client): void {
  if (started) return
  started = true
  scheduleTick(client, 0)
  logger.info('Activity backfill loop started')
}

function scheduleTick(client: Client, delayMs: number): void {
  backfillTimer = setTimeout(() => { void runTick(client) }, delayMs)
}

async function runTick(client: Client): Promise<void> {
  let didWork = false
  try {
    didWork = await tick(client)
  } catch (err) {
    logger.warn(`activity backfill: tick failed: ${(err as Error).message}`)
  }
  // Never a tight setInterval — the delay between batches is settings-driven
  // (stats.backfill.batch_delay_ms) so an operator can slow it down without
  // a restart; the 15s recheck applies whenever there's nothing to do.
  scheduleTick(client, didWork ? settingOrNumber('stats.backfill.batch_delay_ms', DEFAULT_BATCH_DELAY_MS) : RECHECK_DELAY_MS)
}

/** Returns true if a batch was actually processed this tick (drives the next delay). */
async function tick(client: Client): Promise<boolean> {
  if (!getBoolSetting('feature.activity_stats', false) || !getBoolSetting('stats.backfill.enabled', false)) {
    currentChannelId = null
    return false
  }

  const guild = client.guilds.cache.get(env.GUILD_ID)
  if (!guild) return false

  await ensureProgressRows(guild)

  const channelId = await pickChannel()
  if (!channelId) {
    currentChannelId = null
    return false
  }
  currentChannelId = channelId

  await processBatch(guild, channelId)
  return true
}

/**
 * Seed one `activity_backfill_progress` row per text/announcement channel
 * (threads implicitly excluded — they're not in this ChannelType filter).
 * Permission check per house style (precedent: messageCreate.ts:71-76) —
 * channels the bot can't read history in get seeded straight to 'skipped'
 * instead of discovering that mid-fetch. Channel-scan precedent: archive.ts:103.
 */
async function ensureProgressRows(guild: Guild): Promise<void> {
  const me = guild.members.me
  // One bulk SELECT instead of a per-channel existence check — this runs
  // every tick (channels can appear at any time), so N round trips per tick
  // forever would add up on a server with many channels.
  const existingRows = await db.select({
    channelId: activityBackfillProgress.channelId,
    status: activityBackfillProgress.status,
    updatedAt: activityBackfillProgress.updatedAt,
  }).from(activityBackfillProgress)
  const existing = new Map(existingRows.map(r => [r.channelId, r]))

  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) continue

    const perms = me ? channel.permissionsFor(me) : null
    const hasAccess = !!perms?.has(PermissionFlagsBits.ViewChannel) && !!perms.has(PermissionFlagsBits.ReadMessageHistory)

    const row = existing.get(channel.id)
    if (row) {
      // Recovery paths — neither state may be terminal forever:
      //  - 'skipped' rows re-enter the queue as soon as the bot can actually
      //    read the channel (perms granted later, or members.me was null on
      //    the seeding tick and everything got mass-skipped).
      //  - 'error' rows requeue after a cooldown; one transient fetch
      //    failure must not permanently drop the channel's history.
      const requeue =
        (row.status === 'skipped' && hasAccess) ||
        (row.status === 'error' && Date.now() - row.updatedAt.getTime() > ERROR_RETRY_MS)
      if (requeue) {
        await db.update(activityBackfillProgress)
          .set({ status: 'pending', error: null, updatedAt: new Date() })
          .where(eq(activityBackfillProgress.channelId, channel.id))
          .catch(err => logger.warn(`activity backfill: requeue failed #${channel.name}: ${(err as Error).message}`))
      }
      continue
    }

    await db.insert(activityBackfillProgress).values({
      channelId: channel.id,
      guildId: guild.id,
      channelName: channel.name,
      status: hasAccess ? 'pending' : 'skipped',
    }).onConflictDoNothing({ target: activityBackfillProgress.channelId }).catch(err =>
      logger.warn(`activity backfill: failed to seed progress row #${channel.name}: ${(err as Error).message}`),
    )
  }
}

/**
 * Seed/refresh progress rows immediately. The sudo panel calls this when
 * backfill is switched on so its first render isn't an empty "0/0 channels"
 * — the loop itself would only get there on its next 15s recheck.
 */
export async function seedBackfillProgress(client: Client): Promise<void> {
  const guild = client.guilds.cache.get(env.GUILD_ID)
  if (guild) await ensureProgressRows(guild)
}

/** 'running' rows win (resume in-flight work first); otherwise the next 'pending' row. */
async function pickChannel(): Promise<string | null> {
  const [running] = await db.select({ channelId: activityBackfillProgress.channelId })
    .from(activityBackfillProgress).where(eq(activityBackfillProgress.status, 'running')).limit(1)
  if (running) return running.channelId

  const [pending] = await db.select({ channelId: activityBackfillProgress.channelId })
    .from(activityBackfillProgress).where(eq(activityBackfillProgress.status, 'pending')).limit(1)
  return pending?.channelId ?? null
}

function syntheticStartCursor(enabledAtIso: string | null): string {
  const ms = enabledAtIso ? new Date(enabledAtIso).getTime() : Date.now()
  return String(BigInt(Math.floor(ms) - DISCORD_EPOCH_MS) << 22n)
}

async function processBatch(guild: Guild, channelId: string): Promise<void> {
  const [progress] = await db.select().from(activityBackfillProgress).where(eq(activityBackfillProgress.channelId, channelId))
  if (!progress) return

  const channel = (guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null)) as TextChannel | null
  if (!channel || !('messages' in channel)) {
    await db.update(activityBackfillProgress)
      .set({ status: 'skipped', error: 'channel missing or not text-based', updatedAt: new Date() })
      .where(eq(activityBackfillProgress.channelId, channelId))
    return
  }

  const cursor = progress.cursorMessageId ?? syntheticStartCursor(getSetting('stats.enabled_at'))

  if (progress.status !== 'running') {
    await db.update(activityBackfillProgress).set({ status: 'running', updatedAt: new Date() }).where(eq(activityBackfillProgress.channelId, channelId))
  }

  let batch
  try {
    batch = await channel.messages.fetch({ limit: BATCH_SIZE, before: cursor })
  } catch (err: any) {
    if (err?.code === 50001 || err?.code === 50013) {
      await db.update(activityBackfillProgress)
        .set({ status: 'skipped', error: 'Missing Access', updatedAt: new Date() })
        .where(eq(activityBackfillProgress.channelId, channelId))
      return
    }
    await db.update(activityBackfillProgress)
      .set({ status: 'error', error: String(err?.message ?? err).slice(0, 500), updatedAt: new Date() })
      .where(eq(activityBackfillProgress.channelId, channelId))
    return
  }

  const localMessageBuffer = new Map<string, MessageStatsDelta>()
  const localEmojiBuffer = new Map<string, EmojiStatsDelta>()
  let oldest: { id: string; createdAt: Date } | null = null

  for (const msg of batch.values()) {
    // Cursor must advance over EVERY message in the page, bots included — a
    // page of pure bot/webhook messages (log channels, music bots) would
    // otherwise leave the cursor stuck, and the loop would re-fetch the same
    // 100 messages forever while 'running' beats every other channel.
    if (!oldest || msg.createdTimestamp < oldest.createdAt.getTime()) {
      oldest = { id: msg.id, createdAt: msg.createdAt }
    }
    if (msg.author.bot) continue

    const delta = computeMessageDelta(msg)
    mergeMessageDelta(localMessageBuffer, delta)

    for (const e of parseEmojis(msg.content)) {
      mergeEmojiDelta(localEmojiBuffer, {
        guildId: delta.guildId, userId: delta.userId, emojiKey: e.emojiKey,
        emojiName: e.emojiName, custom: e.custom, kind: 'message', bucket: delta.bucket, count: 1,
      })
    }

    // Reactor identities are NOT fetched here — a per-reactor REST call is
    // exactly the rate-limit cost this backfill is trying to avoid. Each
    // reaction's total `count` still credits the message author, so
    // reaction_received totals stay exact; only who gave which reaction is
    // lost for history (documented tradeoff, see DESIGN.md accepted list).
    for (const reaction of msg.reactions.cache.values()) {
      const custom = reaction.emoji.id != null
      mergeEmojiDelta(localEmojiBuffer, {
        guildId: delta.guildId,
        userId: msg.author.id,
        emojiKey: custom ? reaction.emoji.id! : (reaction.emoji.name ?? 'unknown'),
        emojiName: reaction.emoji.name ?? null,
        custom,
        kind: 'reaction_received',
        bucket: delta.bucket,
        count: reaction.count,
      })
    }

  }

  await flushMessageBuffer(localMessageBuffer)
  await flushEmojiBuffer(localEmojiBuffer)

  const scanned = batch.size
  const done = scanned < BATCH_SIZE
  await db.update(activityBackfillProgress).set({
    status: done ? 'done' : 'running',
    cursorMessageId: oldest?.id ?? progress.cursorMessageId,
    messagesScanned: sql`${activityBackfillProgress.messagesScanned} + ${scanned}`,
    oldestSeenAt: oldest?.createdAt ?? progress.oldestSeenAt,
    updatedAt: new Date(),
  }).where(eq(activityBackfillProgress.channelId, channelId))

  if (done) logger.info(`activity backfill: #${channel.name ?? channelId} done (${progress.messagesScanned + scanned} messages scanned)`)
}

export async function getBackfillSummary(): Promise<{
  enabled: boolean
  channels: { total: number; done: number; running: number; pending: number; error: number; skipped: number }
  messagesScanned: number
  currentChannelId: string | null
}> {
  const rows = await db.select().from(activityBackfillProgress)
  const channels = { total: rows.length, done: 0, running: 0, pending: 0, error: 0, skipped: 0 }
  let messagesScanned = 0
  for (const r of rows) {
    messagesScanned += r.messagesScanned
    if (r.status === 'done') channels.done++
    else if (r.status === 'running') channels.running++
    else if (r.status === 'pending') channels.pending++
    else if (r.status === 'error') channels.error++
    else if (r.status === 'skipped') channels.skipped++
  }
  return {
    enabled: getBoolSetting('stats.backfill.enabled', false),
    channels,
    messagesScanned,
    currentChannelId,
  }
}

/**
 * Clears every progress row AND the backfill-sourced aggregate contribution
 * (all rows with bucket < stats.enabled_at are backfill-sourced by
 * construction — live tracking never writes before that point). Both
 * deletes run in one transaction so a re-run can never observe a
 * half-cleared state (progress wiped but old counts still present, or vice
 * versa). If stats.enabled_at is unset, only progress rows are cleared.
 */
export async function resetBackfillProgress(): Promise<void> {
  const enabledAtIso = getSetting('stats.enabled_at')
  await db.transaction(async (tx) => {
    await tx.delete(activityBackfillProgress)
    if (enabledAtIso) {
      const enabledAt = new Date(enabledAtIso)
      await tx.delete(activityMessageStats).where(lt(activityMessageStats.bucket, enabledAt))
      await tx.delete(activityEmojiStats).where(lt(activityEmojiStats.bucket, enabledAt))
    }
  })
  currentChannelId = null
  logger.info(`Activity backfill progress reset${enabledAtIso ? ' (backfilled aggregate history also cleared)' : ''}`)
}
