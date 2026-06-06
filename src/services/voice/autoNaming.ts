import { ActivityType, type Presence, type VoiceBasedChannel, type GuildMember, type Guild } from 'discord.js'

/**
 * Auto-name templates. Templates are NAMING ONLY — they never touch user
 * limit, lock, hide, or any other channel setting. The user is the only
 * authority on user limits (set them via Discord's channel settings UI).
 *
 * Each template inspects current rich presence in the VC and produces a name,
 * or returns null when no presence data is available (caller falls back to
 * `fallback_name` / a random tech name).
 */
export type NameTemplate =
  | 'auto'      // (N) Game — N prefix only when 2+ members play the same game
  | 'counter'   // Game [N] — bare current member count
  | 'squad'     // Game · N squad — count appended once 2+ members
  | 'detail'    // Game — {details} — uses rich presence's details field (e.g. "Match in progress")
  | 'state'     // Game — {state} — uses rich presence's state field (e.g. "Quick Play")
  | 'party'     // Game (X/Y party) — uses rich presence's party.size when present
  | 'stealth'   // Game — bare name, no count, no decoration

export const TEMPLATE_LABELS: Record<NameTemplate, { emoji: string; label: string; description: string }> = {
  auto:    { emoji: '🎮', label: 'Auto',     description: 'Default — game name, prefixed (N) when 2+ play the same' },
  counter: { emoji: '🔢', label: 'Counter',  description: 'Game [N] — bare current member count' },
  squad:   { emoji: '👥', label: 'Squad',    description: 'Game · N squad — appended once 2+ members' },
  detail:  { emoji: '🎬', label: 'Detail',   description: 'Game — {details} — uses rich presence details (e.g. "Match in progress")' },
  state:   { emoji: '📜', label: 'State',    description: 'Game — {state} — uses rich presence state (e.g. "Quick Play")' },
  party:   { emoji: '🎉', label: 'Party',    description: 'Game (X/Y party) — only when rich presence reports a party' },
  stealth: { emoji: '✨', label: 'Stealth',  description: 'Just the game name, no count, no decoration' },
}

export const ALL_TEMPLATES: NameTemplate[] = ['auto', 'counter', 'squad', 'detail', 'state', 'party', 'stealth']

function isNameTemplate(v: string | null): v is NameTemplate {
  return v !== null && (ALL_TEMPLATES as string[]).includes(v)
}

/**
 * Compute the channel name for a given template based on current rich presence
 * in the VC. Returns `null` when nobody is playing anything (caller decides
 * what to do — usually revert to `fallback_name`).
 */
export function computeAutoName(
  vc: VoiceBasedChannel,
  ownerId: string,
  template: string | null,
  /** Legacy positional arg, ignored. Kept so existing call sites still compile. */
  _userLimit?: number,
): string | null {
  const tpl: NameTemplate = isNameTemplate(template) ? template : 'auto'

  const winner = pickTopGame(vc, ownerId)
  if (!winner) return null
  const { game, members, activity } = winner
  const count = members.length
  const memberCount = vc.members.size

  switch (tpl) {
    case 'auto':
      return count > 1 ? `(${count}) ${game}` : game

    case 'counter':
      return `${game} [${memberCount}]`

    case 'squad':
      return memberCount > 1 ? `${game} · ${memberCount} squad` : game

    case 'detail': {
      const detail = takeFirstNonEmpty(activity?.details)
      return detail ? `${game} — ${detail}` : game
    }

    case 'state': {
      const state = takeFirstNonEmpty(activity?.state)
      return state ? `${game} — ${state}` : game
    }

    case 'party': {
      const party = activity?.party
      const size = party?.size
      if (size && size.length === 2) {
        const [cur, max] = size
        if (cur > 0 && max > 0) return `${game} (${cur}/${max} party)`
      }
      return game
    }

    case 'stealth':
      return game
  }
}

/** Pick the most-played game across the VC, owner's game wins ties. */
function pickTopGame(
  vc: VoiceBasedChannel,
  ownerId: string,
): { game: string; members: GuildMember[]; activity: Presence['activities'][number] | null } | null {
  const games = new Map<string, { members: GuildMember[]; activity: Presence['activities'][number] | null }>()
  for (const m of vc.members.values()) {
    const activity = m.presence?.activities.find(a => a.type === ActivityType.Playing) ?? null
    if (!activity?.name) continue
    const key = activity.name
    const entry = games.get(key)
    if (entry) {
      entry.members.push(m)
      // Prefer the owner's activity instance for detail/state extraction.
      if (m.id === ownerId) entry.activity = activity
    } else {
      games.set(key, { members: [m], activity })
    }
  }
  if (games.size === 0) return null

  const ownerGame = (() => {
    for (const [g, e] of games) if (e.members.some(m => m.id === ownerId)) return g
    return undefined
  })()

  let topGame: string | undefined
  let topCount = 0
  for (const [g, e] of games) {
    if (e.members.length > topCount || (e.members.length === topCount && g === ownerGame)) {
      topGame = g
      topCount = e.members.length
    }
  }
  if (!topGame) return null
  const winner = games.get(topGame)!
  return { game: topGame, members: winner.members, activity: winner.activity }
}

function takeFirstNonEmpty(v: string | null | undefined): string | null {
  if (!v) return null
  const trimmed = v.trim()
  return trimmed.length > 0 ? trimmed : null
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
