/**
 * Activity Stats — buffered live collector.
 *
 * Every `record*` export below is cheap and safe to call from a hot Discord
 * gateway handler: each gates on `feature.activity_stats` (+ bot users +
 * `guildId === env.GUILD_ID`) first, never throws (internal try/catch +
 * `logger.warn`), and does NO Discord REST fetches. Message/emoji counts are
 * buffered in memory and drained additively into Postgres every 30s by
 * `startActivityTracker`'s tick — see ./aggregate.ts for the shared
 * parsing/upsert logic (also used by ./backfill.ts so live and historical
 * counting can never drift).
 *
 * Voice sessions are DB-backed (one open row per active join, watermarked by
 * `rolled_up_to` so a restart can adopt them without double-counting).
 * Game (presence) sessions are in-memory only — see the schema doc comment
 * on `activity_presence_stats` for why that's an accepted tradeoff.
 */
import { ActivityType } from 'discord.js'
import type {
  Client,
  GuildMember,
  Message,
  MessageReaction,
  PartialGuildMember,
  PartialMessageReaction,
  PartialUser,
  Presence,
  User,
  VoiceState,
} from 'discord.js'
import { eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import {
  activityMemberEvents,
  activityPresenceStats,
  activityVoiceSessions,
  activityVoiceStats,
} from '../../db/schema'
import { env } from '../../config/env'
import { logger } from '../logger'
import { getBoolSetting, getSetting, setSetting } from '../settings'
import {
  computeMessageDelta,
  flushEmojiBuffer,
  flushMessageBuffer,
  hourBucket,
  mergeEmojiDelta,
  mergeMessageDelta,
  parseEmojis,
  splitIntoHourBuckets,
  type EmojiStatsDelta,
  type MessageStatsDelta,
} from './aggregate'

const FEATURE_KEY = 'feature.activity_stats'
const FLUSH_INTERVAL_MS = 30_000
const GAME_SESSION_CAP_MS = 12 * 60 * 60_000  // 12h
const VOICE_LONG_SESSION_WARN_MS = 24 * 60 * 60_000  // 24h

// ---------------------------------------------------------------------------
// In-memory buffers / session state
// ---------------------------------------------------------------------------

const messageBuffer = new Map<string, MessageStatsDelta>()
const emojiBuffer = new Map<string, EmojiStatsDelta>()

interface OpenVoiceSession {
  id: string
  guildId: string
  userId: string
  channelId: string
  channelName: string | null
  joinedAt: Date
  rolledUpTo: Date
  warnedLongSession: boolean
}
// Keyed by `${channelId}:${userId}` — a user can only have one open voice
// session at a time (moves close the old one before opening the new one).
const openVoiceSessions = new Map<string, OpenVoiceSession>()

interface OpenGameSession {
  guildId: string
  userId: string
  gameName: string
  startedAt: Date
  watermark: Date
}
// Keyed by `${userId}:${gameName}` — Discord allows multiple simultaneous
// "Playing" activities, so this is NOT keyed by user alone.
const openGameSessions = new Map<string, OpenGameSession>()

let flushInterval: ReturnType<typeof setInterval> | null = null
// Cached the same way src/services/logger.ts caches its client — several
// exports here (setActivityStatsEnabled) need a Client but the contract's
// exported signature doesn't carry one, so we stash the one passed to
// startActivityTracker.
let cachedClient: Client | null = null
// Tracks the flag's value as of the last tick so we can detect ON/OFF
// transitions without a dedicated event hook.
let lastFeatureEnabled = false

// ---------------------------------------------------------------------------
// Startup + tick loop
// ---------------------------------------------------------------------------

export function startActivityTracker(client: Client): void {
  if (flushInterval) return
  cachedClient = client
  lastFeatureEnabled = getBoolSetting(FEATURE_KEY, false)
  if (lastFeatureEnabled) {
    void reconcileVoiceSessions(client).catch(err =>
      logger.warn(`activity tracker: startup reconcile failed: ${(err as Error).message}`),
    )
  }
  flushInterval = setInterval(() => {
    void tick(client).catch(err => logger.warn(`activity tracker: tick failed: ${(err as Error).message}`))
  }, FLUSH_INTERVAL_MS)
  logger.info('Activity tracker started — flushing every 30s')
}

async function tick(client: Client): Promise<void> {
  const enabled = getBoolSetting(FEATURE_KEY, false)
  if (enabled !== lastFeatureEnabled) {
    if (enabled) {
      logger.info('Activity stats: feature flag turned ON — reconciling voice sessions')
      await reconcileVoiceSessions(client)
    } else {
      logger.info('Activity stats: feature flag turned OFF — closing open sessions')
      await closeAllOpenSessions()
    }
    lastFeatureEnabled = enabled
  }

  // Flush whatever's buffered even on the tick that just turned the feature
  // off — record* gates read the flag live, so there's always a small
  // window where activity landed in the buffer before this tick noticed the
  // flip. Harmless no-op when the buffers are empty.
  await flushActivityBuffers()
  if (!enabled) return

  await rollUpOpenVoiceSessions()
  await rollUpOpenGameSessions()
}

async function closeAllOpenSessions(): Promise<void> {
  const now = new Date()
  for (const session of Array.from(openVoiceSessions.values())) {
    await closeVoiceSession(session, now)
  }
  openVoiceSessions.clear()
  for (const session of Array.from(openGameSessions.values())) {
    await rollUpGameSession(session, now)
  }
  openGameSessions.clear()
}

// ---------------------------------------------------------------------------
// Voice sessions
// ---------------------------------------------------------------------------

async function openVoiceSession(
  guildId: string,
  channelId: string,
  channelName: string | null,
  userId: string,
  joinedAt: Date,
): Promise<void> {
  const key = `${channelId}:${userId}`
  try {
    const [row] = await db.insert(activityVoiceSessions).values({
      guildId, userId, channelId, channelName, joinedAt, rolledUpTo: joinedAt,
    }).returning()
    if (row) {
      openVoiceSessions.set(key, {
        id: row.id, guildId, userId, channelId, channelName, joinedAt,
        rolledUpTo: joinedAt, warnedLongSession: false,
      })
    }
  } catch (err) {
    logger.warn(`activity: failed to open voice session user=${userId} vc=${channelId}: ${(err as Error).message}`)
  }
}

/** Roll up seconds from `session.rolledUpTo` to `to`, splitting across hour
 * buckets. Always updates the in-memory watermark; `persist` also writes it
 * to `activity_voice_sessions.rolled_up_to` (skip when the caller is about
 * to overwrite that column anyway, e.g. on close). */
async function rollUpVoiceSession(session: OpenVoiceSession, to: Date, persist: boolean): Promise<void> {
  const segments = splitIntoHourBuckets(session.rolledUpTo, to)
  for (const seg of segments) {
    await upsertVoiceStats({
      guildId: session.guildId,
      userId: session.userId,
      channelId: session.channelId,
      channelName: session.channelName,
      bucket: seg.bucket,
      seconds: seg.seconds,
    })
  }
  session.rolledUpTo = to
  if (persist) {
    await db.update(activityVoiceSessions)
      .set({ rolledUpTo: to })
      .where(eq(activityVoiceSessions.id, session.id))
      .catch(err => logger.warn(`activity: failed to persist voice watermark session=${session.id}: ${(err as Error).message}`))
  }
}

async function closeVoiceSession(session: OpenVoiceSession, now: Date): Promise<void> {
  // In-memory-only rollup here — the close update below writes rolled_up_to
  // itself, so persisting it twice would be a wasted round trip.
  await rollUpVoiceSession(session, now, false)
  const durationSeconds = Math.max(0, Math.round((now.getTime() - session.joinedAt.getTime()) / 1000))
  await db.update(activityVoiceSessions)
    .set({ leftAt: now, durationSeconds, rolledUpTo: now })
    .where(eq(activityVoiceSessions.id, session.id))
    .catch(err => logger.warn(`activity: failed to close voice session=${session.id}: ${(err as Error).message}`))
}

async function rollUpOpenVoiceSessions(): Promise<void> {
  const now = new Date()
  for (const session of openVoiceSessions.values()) {
    if (!session.warnedLongSession && now.getTime() - session.joinedAt.getTime() > VOICE_LONG_SESSION_WARN_MS) {
      logger.warn(`activity: voice session user=${session.userId} vc=${session.channelId} has been open > 24h — still rolling up`)
      session.warnedLongSession = true
    }
    await rollUpVoiceSession(session, now, true)
  }
}

/**
 * Fetch every open (`left_at IS NULL`) voice session row and reconcile it
 * against who's actually in the channel right now:
 *   - member still there  → adopt into memory, watermark = rolled_up_to
 *     (falling back to joined_at for pre-this-feature rows) so seconds
 *     already rolled up before the restart never get counted twice.
 *   - member gone         → close it (final rollup from watermark → now).
 * Then opens fresh sessions for anyone currently in voice with no open row
 * (bots excluded; AFK-channel occupants are fine to include).
 */
async function reconcileVoiceSessions(client: Client): Promise<void> {
  const guild = client.guilds.cache.get(env.GUILD_ID)
  if (!guild) {
    logger.warn(`activity: reconcile skipped — guild ${env.GUILD_ID} not in cache`)
    return
  }

  const now = new Date()
  const openRows = await db.select().from(activityVoiceSessions).where(isNull(activityVoiceSessions.leftAt))
  const adopted = new Set<string>()

  for (const row of openRows) {
    const key = `${row.channelId}:${row.userId}`
    const channel = guild.channels.cache.get(row.channelId)
    const stillPresent = channel?.isVoiceBased() && channel.members.has(row.userId)

    if (stillPresent) {
      openVoiceSessions.set(key, {
        id: row.id,
        guildId: row.guildId,
        userId: row.userId,
        channelId: row.channelId,
        channelName: row.channelName,
        joinedAt: row.joinedAt,
        rolledUpTo: row.rolledUpTo ?? row.joinedAt,
        warnedLongSession: false,
      })
      adopted.add(key)
      continue
    }

    const rolledUpTo = row.rolledUpTo ?? row.joinedAt
    const segments = splitIntoHourBuckets(rolledUpTo, now)
    for (const seg of segments) {
      await upsertVoiceStats({
        guildId: row.guildId, userId: row.userId, channelId: row.channelId,
        channelName: row.channelName, bucket: seg.bucket, seconds: seg.seconds,
      })
    }
    const durationSeconds = Math.max(0, Math.round((now.getTime() - row.joinedAt.getTime()) / 1000))
    await db.update(activityVoiceSessions)
      .set({ leftAt: now, durationSeconds, rolledUpTo: now })
      .where(eq(activityVoiceSessions.id, row.id))
      .catch(err => logger.warn(`activity: reconcile close failed session=${row.id}: ${(err as Error).message}`))
  }

  let opened = 0
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isVoiceBased()) continue
    for (const member of channel.members.values()) {
      if (member.user.bot) continue
      const key = `${channel.id}:${member.id}`
      if (adopted.has(key) || openVoiceSessions.has(key)) continue
      await openVoiceSession(channel.guildId, channel.id, channel.name, member.id, now)
      opened++
    }
  }

  logger.info(`activity: voice reconcile complete — adopted=${adopted.size} opened=${opened}`)
}

async function upsertVoiceStats(row: {
  guildId: string; userId: string; channelId: string; channelName: string | null; bucket: Date; seconds: number
}): Promise<void> {
  if (row.seconds <= 0) return
  await db.insert(activityVoiceStats).values(row).onConflictDoUpdate({
    target: [activityVoiceStats.userId, activityVoiceStats.channelId, activityVoiceStats.bucket],
    set: {
      seconds: sql`${activityVoiceStats.seconds} + ${row.seconds}`,
      channelName: row.channelName ?? undefined,
    },
  }).catch(err => logger.warn(`activity: voice stats upsert failed: ${(err as Error).message}`))
}

export function recordVoiceActivity(oldState: VoiceState, newState: VoiceState): void {
  // Mute/deafen/stream/video toggles fire voiceStateUpdate too — only care
  // about actual channel changes.
  if (oldState.channelId === newState.channelId) return
  if (!getBoolSetting(FEATURE_KEY, false)) return
  if (newState.guild.id !== env.GUILD_ID) return
  const member = newState.member ?? oldState.member
  if (!member || member.user.bot) return

  try {
    const now = new Date()

    if (oldState.channelId) {
      const key = `${oldState.channelId}:${member.id}`
      const session = openVoiceSessions.get(key)
      if (session) {
        openVoiceSessions.delete(key)
        void closeVoiceSession(session, now).catch(err =>
          logger.warn(`activity: recordVoiceActivity close failed: ${(err as Error).message}`),
        )
      }
    }

    if (newState.channelId) {
      void openVoiceSession(newState.guild.id, newState.channelId, newState.channel?.name ?? null, member.id, now)
    }
  } catch (err) {
    logger.warn(`activity: recordVoiceActivity failed: ${(err as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Presence (game) sessions — in-memory only, see schema doc comment
// ---------------------------------------------------------------------------

async function rollUpGameSession(session: OpenGameSession, to: Date): Promise<void> {
  const segments = splitIntoHourBuckets(session.watermark, to)
  for (const seg of segments) {
    await upsertPresenceStats({
      guildId: session.guildId, userId: session.userId, gameName: session.gameName,
      bucket: seg.bucket, seconds: seg.seconds,
    })
  }
  session.watermark = to
}

async function rollUpOpenGameSessions(): Promise<void> {
  const now = new Date()
  for (const [key, session] of Array.from(openGameSessions.entries())) {
    const capAt = new Date(session.startedAt.getTime() + GAME_SESSION_CAP_MS)
    if (now >= capAt) {
      // Force-close at the cap instead of letting it run forever — roll up
      // only to the cap point, then drop the session. If they're still
      // playing, the next presenceUpdate with an unchanged game name won't
      // fire (no diff), so this game simply stops accruing until they stop
      // and restart it (or the bot restarts).
      await rollUpGameSession(session, capAt)
      openGameSessions.delete(key)
      logger.warn(`activity: game session user=${session.userId} game=${session.gameName} force-closed at 12h cap`)
      continue
    }
    await rollUpGameSession(session, now)
  }
}

async function upsertPresenceStats(row: {
  guildId: string; userId: string; gameName: string; bucket: Date; seconds: number
}): Promise<void> {
  if (row.seconds <= 0) return
  await db.insert(activityPresenceStats).values(row).onConflictDoUpdate({
    target: [activityPresenceStats.userId, activityPresenceStats.gameName, activityPresenceStats.bucket],
    set: { seconds: sql`${activityPresenceStats.seconds} + ${row.seconds}` },
  }).catch(err => logger.warn(`activity: presence stats upsert failed: ${(err as Error).message}`))
}

export function recordPresenceActivity(oldPresence: Presence | null, newPresence: Presence): void {
  if (!getBoolSetting(FEATURE_KEY, false)) return
  if (newPresence.guild?.id !== env.GUILD_ID) return
  const member = newPresence.member
  if (!member || member.user.bot) return

  try {
    const now = new Date()
    const oldGames = new Set(
      (oldPresence?.activities ?? []).filter(a => a.type === ActivityType.Playing).map(a => a.name),
    )
    const newGames = new Set(
      newPresence.activities.filter(a => a.type === ActivityType.Playing).map(a => a.name),
    )

    // Started playing — open an in-memory session (watermark = now).
    for (const name of newGames) {
      if (oldGames.has(name)) continue
      const key = `${member.id}:${name}`
      if (openGameSessions.has(key)) continue
      openGameSessions.set(key, { guildId: member.guild.id, userId: member.id, gameName: name, startedAt: now, watermark: now })
    }

    // Stopped playing — final rollup + close.
    for (const name of oldGames) {
      if (newGames.has(name)) continue
      const key = `${member.id}:${name}`
      const session = openGameSessions.get(key)
      if (!session) continue
      openGameSessions.delete(key)
      void rollUpGameSession(session, now).catch(err =>
        logger.warn(`activity: game session stop rollup failed: ${(err as Error).message}`),
      )
    }

    // Going offline closes ALL of this user's open game sessions.
    if (newPresence.status === 'offline') {
      for (const [key, session] of Array.from(openGameSessions.entries())) {
        if (session.userId !== member.id) continue
        openGameSessions.delete(key)
        void rollUpGameSession(session, now).catch(err =>
          logger.warn(`activity: game session offline-close rollup failed: ${(err as Error).message}`),
        )
      }
    }
  } catch (err) {
    logger.warn(`activity: recordPresenceActivity failed: ${(err as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Messages + emojis (buffered)
// ---------------------------------------------------------------------------

export function recordMessageActivity(msg: Message): void {
  if (!getBoolSetting(FEATURE_KEY, false)) return
  if (!msg.guildId || msg.guildId !== env.GUILD_ID) return
  if (msg.author.bot) return

  try {
    const delta = computeMessageDelta(msg)
    mergeMessageDelta(messageBuffer, delta)

    const emojis = parseEmojis(msg.content)
    for (const e of emojis) {
      mergeEmojiDelta(emojiBuffer, {
        guildId: delta.guildId, userId: delta.userId, emojiKey: e.emojiKey,
        emojiName: e.emojiName, custom: e.custom, kind: 'message', bucket: delta.bucket, count: 1,
      })
    }
  } catch (err) {
    logger.warn(`activity: recordMessageActivity failed: ${(err as Error).message}`)
  }
}

export function recordReactionActivity(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  added: boolean,
): void {
  // Counts are monotonic — see the activity_emoji_stats schema doc comment.
  // The original add's hour bucket is unknowable at removal time, so
  // removals are dropped instead of risking corrupting an unrelated bucket.
  if (!added) return
  if (!getBoolSetting(FEATURE_KEY, false)) return
  if (!reaction.message.guildId || reaction.message.guildId !== env.GUILD_ID) return
  if (user.bot) return

  try {
    const bucket = hourBucket(Date.now())
    const custom = reaction.emoji.id != null
    const emojiKey = custom ? reaction.emoji.id! : (reaction.emoji.name ?? 'unknown')
    const emojiName = reaction.emoji.name ?? null

    mergeEmojiDelta(emojiBuffer, {
      guildId: reaction.message.guildId, userId: user.id, emojiKey, emojiName,
      custom, kind: 'reaction_given', bucket, count: 1,
    })

    // Uncached (pre-restart) messages are intentionally skipped here — a
    // REST fetch per reaction is the exact cost messageReaction.ts was
    // built to avoid. Backfill covers the historical received counts.
    if (!reaction.message.partial && reaction.message.author && !reaction.message.author.bot) {
      mergeEmojiDelta(emojiBuffer, {
        guildId: reaction.message.guildId, userId: reaction.message.author.id, emojiKey, emojiName,
        custom, kind: 'reaction_received', bucket, count: 1,
      })
    }
  } catch (err) {
    logger.warn(`activity: recordReactionActivity failed: ${(err as Error).message}`)
  }
}

export function recordMemberEvent(member: GuildMember | PartialGuildMember, event: 'join' | 'leave'): void {
  if (!getBoolSetting(FEATURE_KEY, false)) return
  if (member.guild.id !== env.GUILD_ID) return
  if (member.user?.bot) return

  // at is passed explicitly (not defaultNow()) — server TZ shouldn't matter
  // for a `timestamp` column, but every other write in this feature stamps
  // its own `new Date()` rather than trusting the column default, so this
  // stays consistent with that pattern.
  void db.insert(activityMemberEvents).values({
    guildId: member.guild.id,
    userId: member.id,
    event,
    at: new Date(),
    memberCount: member.guild.memberCount,
  }).catch(err => logger.warn(`activity: recordMemberEvent failed: ${(err as Error).message}`))
}

// ---------------------------------------------------------------------------
// Feature toggle + manual flush
// ---------------------------------------------------------------------------

export async function setActivityStatsEnabled(enabled: boolean, byDiscordId?: string): Promise<void> {
  await setSetting(FEATURE_KEY, enabled ? 'true' : 'false', byDiscordId)
  if (enabled && !getSetting('stats.enabled_at')) {
    await setSetting('stats.enabled_at', new Date().toISOString(), byDiscordId, { audit: false })
  }

  // Do the transition work here (rather than waiting up to 30s for the next
  // tick) and mark it done so the tick's own ON/OFF-transition detector
  // doesn't redo it.
  lastFeatureEnabled = enabled
  if (enabled) {
    if (cachedClient) {
      await reconcileVoiceSessions(cachedClient).catch(err =>
        logger.warn(`activity: reconcile on enable failed: ${(err as Error).message}`),
      )
    }
  } else {
    await closeAllOpenSessions()
    await flushActivityBuffers()
  }
}

export async function flushActivityBuffers(): Promise<void> {
  await flushMessageBuffer(messageBuffer)
  await flushEmojiBuffer(emojiBuffer)
}
