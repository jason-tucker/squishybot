/**
 * Serialized writer for hub @everyone permission overwrites.
 *
 * discord.js `permissionOverwrites.edit` is not a bit-level patch: it merges the
 * options into the CACHED overwrite and PUTs the whole allow/deny pair. The PUT
 * returns 204, so the cache only catches up when the CHANNEL_UPDATE gateway event
 * arrives. Two writers on the same overwrite (overflow gate: ViewChannel,
 * hub lockdown: Connect) can therefore erase each other's bit.
 *
 * Every hub @everyone write goes through here: a per-channel mutex, then a
 * forced REST fetch so the edit merges against fresh server state.
 *
 * The lock is NOT re-entrant: never take the same channel id inside `fn`.
 */
import { ChannelType, RESTJSONErrorCodes, type Guild, type VoiceChannel } from 'discord.js'
import { logger } from '../logger'

const tails = new Map<string, Promise<void>>()

/** Run `fn` after every earlier holder of `channelId`'s lock has finished. */
export function withChannelLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(channelId) ?? Promise.resolve()
  const run = prev.then(() => fn(), () => fn())
  const tail = run.then(() => {}, () => {})
  tails.set(channelId, tail)
  void tail.then(() => { if (tails.get(channelId) === tail) tails.delete(channelId) })
  return run
}

export type FreshVoice =
  | { kind: 'ok'; ch: VoiceChannel }
  | { kind: 'missing' }
  | { kind: 'failed'; error: unknown }

/**
 * REST-fetch a voice channel, refreshing its cached overwrites. `missing` when
 * the channel is gone (Unknown Channel) or is not a plain voice channel;
 * `failed` for any other error (callers keep their state and retry later).
 */
export async function fetchFreshVoice(guild: Guild, channelId: string): Promise<FreshVoice> {
  try {
    const ch = await guild.channels.fetch(channelId, { force: true })
    if (!ch || ch.type !== ChannelType.GuildVoice) return { kind: 'missing' }
    return { kind: 'ok', ch }
  } catch (err) {
    if ((err as { code?: unknown })?.code === RESTJSONErrorCodes.UnknownChannel) return { kind: 'missing' }
    return { kind: 'failed', error: err }
  }
}

export type EveryonePatch = { ViewChannel?: boolean | null; Connect?: boolean | null }

/**
 * Edit bits of a channel's @everyone overwrite under the channel lock, after a
 * fresh fetch. `decide` sees the fresh channel and returns the patch, or null
 * when nothing needs writing. Never throws.
 */
export async function editEveryoneBits(
  guild: Guild,
  channelId: string,
  decide: (ch: VoiceChannel) => EveryonePatch | null,
  reason: string,
): Promise<'written' | 'skipped' | 'missing' | 'failed'> {
  return withChannelLock(channelId, async () => {
    const fresh = await fetchFreshVoice(guild, channelId)
    if (fresh.kind === 'missing') return 'missing'
    if (fresh.kind === 'failed') {
      logger.warn(`hubPermWriter(${reason}): failed to fetch channel ${channelId}: ${(fresh.error as Error)?.message ?? fresh.error}`)
      return 'failed'
    }
    const patch = decide(fresh.ch)
    if (!patch) return 'skipped'
    try {
      await fresh.ch.permissionOverwrites.edit(guild.roles.everyone, patch, { reason })
      return 'written'
    } catch (err) {
      logger.warn(`hubPermWriter(${reason}): failed to edit @everyone on ${channelId}: ${(err as Error)?.message ?? err}`)
      return 'failed'
    }
  })
}
