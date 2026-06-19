import { ActivityType, type VoiceBasedChannel, type Guild } from 'discord.js'

/**
 * Smart auto-naming. NAMING ONLY — it never touches user limit, lock, hide, or
 * any other channel setting. The user is the only authority on user limits
 * (set them via Discord's channel settings UI).
 *
 * The rule is deliberately simple: when **2 or more** members in the VC are
 * playing the same game, the room is named after that game. Otherwise this
 * returns `null` and the caller falls back to `fallback_name` (the room's
 * created/random name). A manual rename or the Randomize button freezes the
 * name by turning `auto_name_enabled` off, so this never runs for those rooms.
 */
export function computeAutoName(
  vc: VoiceBasedChannel,
  ownerId: string,
): string | null {
  const winner = pickTopGame(vc, ownerId)
  if (!winner) return null
  // Only rename when at least two people are on the same game. A lone player
  // doesn't rename the room — it keeps its fallback name.
  return winner.count >= 2 ? winner.game : null
}

/** Pick the most-played game across the VC, owner's game wins ties. */
function pickTopGame(
  vc: VoiceBasedChannel,
  ownerId: string,
): { game: string; count: number } | null {
  const games = new Map<string, number>()
  for (const m of vc.members.values()) {
    const activity = m.presence?.activities.find(a => a.type === ActivityType.Playing) ?? null
    if (!activity?.name) continue
    games.set(activity.name, (games.get(activity.name) ?? 0) + 1)
  }
  if (games.size === 0) return null

  const ownerGame = (() => {
    const owner = vc.members.get(ownerId)
    const a = owner?.presence?.activities.find(x => x.type === ActivityType.Playing)
    return a?.name
  })()

  let topGame: string | undefined
  let topCount = 0
  for (const [g, c] of games) {
    if (c > topCount || (c === topCount && g === ownerGame)) {
      topGame = g
      topCount = c
    }
  }
  if (!topGame) return null
  return { game: topGame, count: topCount }
}

/**
 * Trailing emojis appended after every auto-channel name. The first is the
 * default; the rest are collision-dodging fallbacks (see decorateChannelName).
 */
export const NAME_EMOJIS = ['🎮', '🕹️', '🎯', '🔥', '⭐', '🚀', '🌟', '⚡', '🎲', '💫'] as const

/** Strip a trailing NAME_EMOJIS decoration (incl. any " N" dedupe suffix) so a
 *  name can be re-decorated without the emoji accreting on every rename. */
function stripDecoration(name: string): string {
  const s = name.trim()
  for (const emoji of NAME_EMOJIS) {
    // "Base 🎮" or "Base 🎮 2" (counter fallback from a fully-exhausted pool)
    const re = new RegExp(`\\s*${escapeRegExp(emoji)}(?:\\s+\\d+)?\\s*$`, 'u')
    if (re.test(s)) return s.replace(re, '').trim()
  }
  return s
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Append a trailing emoji to an auto-channel name, choosing one that keeps the
 * full name distinct from every other channel in the guild. Discord permits
 * duplicate channel names, but an auto channel whose name exactly matches an
 * existing channel — a static "overwatch" channel, or another VC already
 * playing the same game — is confusing. We dodge by trying the next trailing
 * emoji until the resulting name is unique.
 *
 * `selfChannelId` is excluded from the collision set so re-decorating a channel
 * with an unchanged base name is stable (same emoji back → the caller's
 * `vc.name === desired` check short-circuits → no rename churn).
 */
export function decorateChannelName(guild: Guild, baseName: string, selfChannelId: string): string {
  const taken = new Set<string>()
  for (const ch of guild.channels.cache.values()) {
    if (ch.id === selfChannelId) continue
    taken.add(ch.name.toLowerCase())
  }
  // Strip any existing decoration first so emojis don't pile up across renames,
  // then leave headroom under Discord's 100-char channel-name limit.
  const base = stripDecoration(baseName).slice(0, 90).trim()
  for (const emoji of NAME_EMOJIS) {
    const candidate = `${base} ${emoji}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  // Pool exhausted (10+ identically-named channels) — default emoji + counter.
  for (let n = 2; ; n++) {
    const candidate = `${base} ${NAME_EMOJIS[0]} ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}
