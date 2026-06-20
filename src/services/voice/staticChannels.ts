/**
 * Registry of "static" voice channels — permanent VCs where the bot creates a
 * companion text channel on join but NEVER renames, replaces, or deletes the VC
 * itself. Only the companion text channel follows the normal cleanup lifecycle.
 *
 * The list is stored in bot_settings under the key `voice.static_channel_ids`
 * as a comma-separated string of channel IDs (same pattern used for
 * HUB_CHANNEL_IDS). Reads are synchronous via getSetting (in-memory cache);
 * writes hit the DB and update the cache via setSetting.
 */
import { getSetting, setSetting } from '../settings'

const SETTING_KEY = 'voice.static_channel_ids'

/**
 * Parse the bot_settings value into a deduplicated list of channel ID strings.
 */
export function getStaticChannelIds(): string[] {
  const raw = getSetting(SETTING_KEY)
  if (!raw) return []
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

/**
 * Returns true when `id` is registered as a static voice channel.
 */
export function isStaticChannel(id: string): boolean {
  return getStaticChannelIds().includes(id)
}

/**
 * Add a voice channel to the static registry. No-op if already present.
 */
export async function addStaticChannel(channelId: string, byUserId: string): Promise<void> {
  const current = new Set(getStaticChannelIds())
  if (current.has(channelId)) return
  current.add(channelId)
  await setSetting(SETTING_KEY, Array.from(current).join(','), byUserId)
}

/**
 * Remove a voice channel from the static registry. No-op if not present.
 */
export async function removeStaticChannel(channelId: string, byUserId?: string): Promise<void> {
  const current = new Set(getStaticChannelIds())
  if (!current.has(channelId)) return
  current.delete(channelId)
  const next = Array.from(current).join(',')
  // If the set is now empty, write an empty string (setSetting stores it;
  // getStaticChannelIds filters it to an empty array on the next read).
  await setSetting(SETTING_KEY, next, byUserId)
}
