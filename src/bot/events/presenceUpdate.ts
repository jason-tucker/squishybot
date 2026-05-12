import { ActivityType, type Client, type Presence } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { maybeRenameChannel, clearRenameState } from '../../services/voice/autoRename'
import { debouncedPanelRefresh } from '../../services/voice/controlPanel'
import { getBoolSetting, isAutoChannelVoice } from '../../services/settings'
import { logger } from '../../services/logger'

/** Drop the per-channel rename state when an auto-channel is deleted. */
export function clearRenameThrottle(voiceChannelId: string): void {
  clearRenameState(voiceChannelId)
}

/** Snapshot the four fields the rename pipeline + panel care about. */
function playingFingerprint(p: Presence | null | undefined): string {
  const a = p?.activities.find(act => act.type === ActivityType.Playing) ?? null
  if (!a) return ''
  const party = a.party?.size && a.party.size.length === 2 ? `${a.party.size[0]}/${a.party.size[1]}` : ''
  return `${a.name}|${a.details ?? ''}|${a.state ?? ''}|${party}`
}

export function registerPresenceUpdate(client: Client): void {
  client.on('presenceUpdate', async (oldPresence: Presence | null, newPresence: Presence) => {
    if (newPresence.guild?.id !== env.GUILD_ID) return
    if (!newPresence.userId) return

    const memberVcId = newPresence.member?.voice.channelId
    if (!memberVcId) return

    // Hot-path short-circuit: only proceed when the user is in a tracked
    // auto-voice channel. Without this check we'd hit Postgres on every
    // single guild-wide presence update (every game start/stop, RP detail
    // change, party tick, etc) regardless of whether anyone is in an
    // auto-channel. The cache is populated/torn-down with the lifecycle
    // hooks in autoChannel.ts, so it's always in sync with the DB.
    if (!isAutoChannelVoice(memberVcId)) return

    // Skip when nothing the rename pipeline OR panel cares about changed.
    // Discord fires presenceUpdate for status-only changes (online → idle),
    // custom-status edits, Spotify activity, etc — none of which affect the
    // channel name or our panel rendering.
    if (playingFingerprint(oldPresence) === playingFingerprint(newPresence)) return

    const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, memberVcId))
    if (!record) return

    // Rename is gated by the feature flag so the kill switch works.
    // Pass the record we already have to avoid maybeRenameChannel's own
    // DB select.
    if (getBoolSetting('feature.presence_renames', true)) {
      await maybeRenameChannel(client, record).catch(err =>
        logger.warn(`presenceUpdate rename: ${(err as Error).message}`),
      )
    }
    // Coalesce rapid presence updates into one panel re-render. The hash
    // dedup inside postOrUpdateControlPanel skips silent edits.
    debouncedPanelRefresh(client, record)
  })
}
