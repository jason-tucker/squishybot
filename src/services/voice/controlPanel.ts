import type { Client, TextChannel, VoiceBasedChannel } from 'discord.js'
import { ActivityType } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import {
  buildControlPanelPayload,
  type MemberPresenceInfo,
} from '../../embeds/voiceControlPanel'
import type { AutoChannelRecord } from '../../types/voice'
import { listMembers } from './voiceMembers'
import { logger } from '../logger'

/**
 * Hash of the inputs that drive the panel render, keyed by voiceChannelId.
 * Lets us skip a no-op `existing.edit()` when nothing visible changed —
 * voiceStateUpdate fires for mute/deafen/self-video toggles too, and we'd
 * otherwise hit Discord with an edit per such event. Cleared from
 * `deleteAutoChannel` via {@link clearPanelHash}.
 */
const lastPanelInputHash = new Map<string, string>()

export function clearPanelHash(voiceChannelId: string): void {
  lastPanelInputHash.delete(voiceChannelId)
}

export async function buildPanelPayloadForRecord(client: Client, record: AutoChannelRecord) {
  const [{ ownerTag, hostTags }, members] = await Promise.all([
    resolveDisplayTags(client, record),
    resolveMembersWithPresence(client, record.voiceChannelId),
  ])
  return buildControlPanelPayload(record, ownerTag, hostTags, members)
}

async function resolveDisplayTags(client: Client, record: AutoChannelRecord): Promise<{ ownerTag: string; hostTags: string[] }> {
  const guild = client.guilds.cache.first()
  if (!guild) return { ownerTag: `<@${record.ownerUserId}>`, hostTags: record.hostUserIds.map(id => `<@${id}>`) }

  // Prefer cache (GuildMembers intent populates it on READY + on join). Falls
  // back to fetch only on miss. Without this, every voiceStateUpdate fired
  // 1+N HTTP round-trips just to render display names — cache.get is free.
  const resolveDisplayName = async (id: string): Promise<string> => {
    const cached = guild.members.cache.get(id)
    if (cached) return cached.displayName
    const fetched = await guild.members.fetch(id).catch(() => null)
    return fetched ? fetched.displayName : `<@${id}>`
  }

  const [ownerTag, ...hostTags] = await Promise.all([
    resolveDisplayName(record.ownerUserId),
    ...record.hostUserIds.map(resolveDisplayName),
  ])
  return { ownerTag, hostTags }
}

/** Pull the DB join rows and overlay each user's current "Playing X" activity. */
async function resolveMembersWithPresence(client: Client, voiceChannelId: string): Promise<MemberPresenceInfo[]> {
  const rows = await listMembers(voiceChannelId)
  const guild = client.guilds.cache.first()
  return rows.map(r => {
    const member = guild?.members.cache.get(r.userId)
    const game = member?.presence?.activities.find(a => a.type === ActivityType.Playing)?.name ?? null
    return { userId: r.userId, joinedAt: r.joinedAt, game }
  })
}

/**
 * Post the panel for a fresh channel, or edit-in-place if a tracked panel
 * already exists. `prefetchedTextChannel` lets callers (createAutoChannel)
 * skip the channels.fetch round-trip — important right after creation when
 * the bot's channel cache may not yet contain the new ID.
 */
export async function postOrUpdateControlPanel(
  client: Client,
  record: AutoChannelRecord,
  prefetchedTextChannel?: TextChannel,
): Promise<void> {
  const guild = client.guilds.cache.first()
  if (!guild) {
    logger.warn(`postOrUpdateControlPanel: no guild in cache for vc=${record.voiceChannelId}`)
    return
  }

  let textChannel: TextChannel | null = prefetchedTextChannel ?? null
  if (!textChannel) {
    const fetched = await guild.channels.fetch(record.textChannelId).catch(() => null)
    if (!fetched || !fetched.isTextBased()) {
      logger.warn(`postOrUpdateControlPanel: text channel ${record.textChannelId} unavailable (vc=${record.voiceChannelId})`)
      return
    }
    textChannel = fetched as TextChannel
  }

  const [{ ownerTag, hostTags }, members] = await Promise.all([
    resolveDisplayTags(client, record),
    resolveMembersWithPresence(client, record.voiceChannelId),
  ])
  const payload = buildControlPanelPayload(record, ownerTag, hostTags, members)

  if (record.controlPanelMsgId) {
    // Skip a no-op edit when none of the visible inputs changed. The hash
    // covers everything `buildControlPanelPayload` reads: record state,
    // owner/host display names, member list with presence + join times.
    const inputHash = JSON.stringify({
      o: record.ownerUserId,
      h: record.hostUserIds,
      l: record.isLocked,
      d: record.isHidden,
      n: record.manualName,
      t: ownerTag,
      ht: hostTags,
      m: members.map(m => [m.userId, m.joinedAt.getTime(), m.game]),
    })
    if (lastPanelInputHash.get(record.voiceChannelId) === inputHash) return

    const existing = await textChannel.messages.fetch(record.controlPanelMsgId).catch(() => null)
    if (existing) {
      const editErr = await existing.edit({ ...payload, content: null } as any).then(() => null).catch(err => err)
      if (editErr) {
        logger.error(`Failed to edit control panel (vc=${record.voiceChannelId}):`, editErr)
      } else {
        lastPanelInputHash.set(record.voiceChannelId, inputHash)
      }
      return
    }
  }

  const msg = await textChannel.send(payload as any).catch(err => {
    logger.warn(`Failed to post control panel (vc=${record.voiceChannelId}):`, err)
    return null
  })
  if (!msg) return

  await db.update(autoChannels)
    .set({ controlPanelMsgId: msg.id })
    .where(eq(autoChannels.voiceChannelId, record.voiceChannelId))
    .catch(err => logger.warn(`Failed to persist control_panel_msg_id (vc=${record.voiceChannelId}):`, err))
}

/** Re-export so VoiceBasedChannel is accessible to callers wiring up the prefetch path. */
export type { VoiceBasedChannel }
