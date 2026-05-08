import { ActivityType, type VoiceBasedChannel } from 'discord.js'

/**
 * Pick the channel name from current rich presence: the most-played game
 * across all VC members, prefixed with the count when more than one person
 * is playing it. Owner's game wins ties.
 *
 * Returns `null` when nobody is playing anything.
 *
 * Examples:
 *   - 1 person playing Overwatch → "Overwatch"
 *   - 3 people playing Overwatch + 1 playing Wordle → "(3) Overwatch"
 *   - With template='counter' → "(3) Overwatch [4/4]"
 *
 * `userLimit` is only used when `template === 'counter'`.
 */
export function computeAutoName(
  vc: VoiceBasedChannel,
  ownerId: string,
  template: string | null,
  userLimit: number,
): string | null {
  const games = new Map<string, string[]>()
  for (const m of vc.members.values()) {
    const game = m.presence?.activities.find(a => a.type === ActivityType.Playing)?.name
    if (!game) continue
    const list = games.get(game) ?? []
    list.push(m.id)
    games.set(game, list)
  }
  if (games.size === 0) return null

  // Find the owner's game (if any) for tiebreaking.
  const ownerGame = (() => {
    for (const [game, ids] of games) {
      if (ids.includes(ownerId)) return game
    }
    return undefined
  })()

  let topGame: string | undefined
  let topCount = 0
  for (const [game, ids] of games) {
    if (ids.length > topCount || (ids.length === topCount && game === ownerGame)) {
      topGame = game
      topCount = ids.length
    }
  }
  if (!topGame) return null

  const count = games.get(topGame)!.length
  const prefix = count > 1 ? `(${count}) ` : ''

  if (template === 'counter') {
    const limit = userLimit > 0 ? userLimit : 4
    return `${prefix}${topGame} [${vc.members.size}/${limit}]`
  }
  return `${prefix}${topGame}`
}
