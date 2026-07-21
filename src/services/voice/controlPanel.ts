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

// Debounced panel refresh — presenceUpdate can fire many times per second
// when a user's rich presence changes rapidly (game state ticks, party
// updates). We coalesce into one re-render per channel per debounce window;
// the existing hash dedup inside postOrUpdateControlPanel then skips if
// nothing visible actually changed.
const pendingPanelRefresh = new Map<string, NodeJS.Timeout>()
const PANEL_DEBOUNCE_MS = 1500

export function debouncedPanelRefresh(client: Client, record: AutoChannelRecord): void {
  const key = record.voiceChannelId
  const existing = pendingPanelRefresh.get(key)
  if (existing) clearTimeout(existing)
  pendingPanelRefresh.set(key, setTimeout(async () => {
    pendingPanelRefresh.delete(key)
    // Re-fetch in case the record changed during the debounce window
    // (rename / host changes / lock toggle / etc). Cheap: at most one query
    // per debounce window per channel.
    const [fresh] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, key)).catch(() => [])
    if (!fresh) return
    await postOrUpdateControlPanel(client, fresh).catch(() => {})
  }, PANEL_DEBOUNCE_MS))
}

export function cancelPanelRefresh(voiceChannelId: string): void {
  const t = pendingPanelRefresh.get(voiceChannelId)
  if (t) {
    clearTimeout(t)
    pendingPanelRefresh.delete(voiceChannelId)
  }
}

export async function buildPanelPayloadForRecord(client: Client, record: AutoChannelRecord) {
  const [{ ownerTag, hostTags }, members] = await Promise.all([
    resolveDisplayTags(client, record),
    resolveMembersWithPresence(client, record.guildId, record.voiceChannelId),
  ])
  const guild = client.guilds.cache.get(record.guildId)
  const vc = guild?.channels.cache.get(record.voiceChannelId)
  const liveName = (vc && 'name' in vc) ? vc.name : record.fallbackName ?? '(unknown)'
  const nameContext = explainName(record, members, liveName)
  return buildControlPanelPayload(record, ownerTag, hostTags, members, nameContext)
}

async function resolveDisplayTags(client: Client, record: AutoChannelRecord): Promise<{ ownerTag: string; hostTags: string[] }> {
  const guild = client.guilds.cache.get(record.guildId)
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
async function resolveMembersWithPresence(client: Client, guildId: string, voiceChannelId: string): Promise<MemberPresenceInfo[]> {
  const rows = await listMembers(voiceChannelId)
  const guild = client.guilds.cache.get(guildId)
  return rows.map(r => {
    const member = guild?.members.cache.get(r.userId)
    const playing = member?.presence?.activities.find(a => a.type === ActivityType.Playing) ?? null
    const partyArr = playing?.party?.size
    const partySize: [number, number] | null = partyArr && partyArr.length === 2 ? [partyArr[0], partyArr[1]] : null
    return {
      userId: r.userId,
      joinedAt: r.joinedAt,
      game: playing?.name ?? null,
      details: playing?.details ?? null,
      state: playing?.state ?? null,
      partySize,
    }
  })
}

/**
 * Human-readable "why is the channel named what it is" line for the panel.
 * Computes the explanation from the record + the live members' presence.
 */
function explainName(
  record: AutoChannelRecord,
  members: MemberPresenceInfo[],
  liveChannelName: string,
): { currentName: string; reason: string } {
  // Static VCs keep their name permanently — no rename, no auto-naming.
  if (record.sourceHubId === 'static') {
    return { currentName: liveChannelName, reason: 'This is a **static channel** — its name is fixed and never changes.' }
  }
  if (!record.autoNameEnabled) {
    return { currentName: liveChannelName, reason: 'Auto-naming is **off** — this name is frozen (set via Rename or 🎲 Randomize). Rename to blank to hand control back to Smart.' }
  }
  // Smart auto-naming: name the room after whatever game 2+ members share.
  const counts = new Map<string, number>()
  for (const m of members) if (m.game) counts.set(m.game, (counts.get(m.game) ?? 0) + 1)
  const ownerGame = members.find(m => m.userId === record.ownerUserId)?.game ?? null
  let top: string | null = null
  let topCount = 0
  for (const [g, c] of counts) {
    if (c > topCount || (c === topCount && g === ownerGame)) { top = g; topCount = c }
  }
  if (top && topCount >= 2) {
    return {
      currentName: liveChannelName,
      reason: `🏷️ Smart auto-naming — **${topCount}** people playing **${top}**, so the room is named after it.`,
    }
  }
  return {
    currentName: liveChannelName,
    reason: `🏷️ Smart auto-naming **on** — waiting for **2+** people on the same game. Until then it stays **${record.fallbackName ?? liveChannelName}**.`,
  }
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
  const guild = client.guilds.cache.get(record.guildId)
  if (!guild) {
    logger.warn(`postOrUpdateControlPanel: guild ${record.guildId} not in cache for vc=${record.voiceChannelId}`)
    return
  }

  let textChannel: TextChannel | null = prefetchedTextChannel ?? null
  if (!textChannel) {
    // The bot manages this channel, so it should be in the local cache.
    // Try cache first; only fall back to a network fetch on miss. This
    // makes us resilient to transient API hiccups (5xx, rate limits, etc.)
    // that would otherwise quietly stall the panel until the next voice
    // event re-tried — which might be hours later.
    const cached = guild.channels.cache.get(record.textChannelId) ?? null
    if (cached && cached.isTextBased()) {
      textChannel = cached as TextChannel
    } else {
      let fetchErr: unknown = null
      const fetched = await guild.channels.fetch(record.textChannelId).catch(err => {
        fetchErr = err
        return null
      })
      if (!fetched || !fetched.isTextBased()) {
        const errInfo = fetchErr ? ` (fetch error: code=${(fetchErr as any)?.code ?? '?'} status=${(fetchErr as any)?.status ?? '?'} msg=${(fetchErr as any)?.message ?? String(fetchErr)})` : ''
        logger.warn(`postOrUpdateControlPanel: text channel ${record.textChannelId} unavailable (vc=${record.voiceChannelId})${errInfo}`)
        return
      }
      textChannel = fetched as TextChannel
    }
  }

  const [{ ownerTag, hostTags }, members] = await Promise.all([
    resolveDisplayTags(client, record),
    resolveMembersWithPresence(client, record.guildId, record.voiceChannelId),
  ])
  const vc = guild.channels.cache.get(record.voiceChannelId)
  const liveName = (vc && 'name' in vc) ? vc.name : record.fallbackName ?? '(unknown)'
  const nameContext = explainName(record, members, liveName)
  const payload = buildControlPanelPayload(record, ownerTag, hostTags, members, nameContext)

  if (record.controlPanelMsgId) {
    // Skip a no-op edit when none of the visible inputs changed. The hash
    // covers everything `buildControlPanelPayload` reads: record state,
    // owner/host display names, member list with presence + join times,
    // and the rich-presence detail/state/party fields surfaced in the
    // "why this name" line.
    const inputHash = JSON.stringify({
      o: record.ownerUserId,
      h: record.hostUserIds,
      l: record.isLocked,
      d: record.isHidden,
      n: record.manualName,
      t: ownerTag,
      ht: hostTags,
      m: members.map(m => [m.userId, m.joinedAt.getTime(), m.game, m.details, m.state, m.partySize?.[0] ?? null, m.partySize?.[1] ?? null]),
      ao: record.actingOwnerUserId,
      gx: record.ownerGraceExpiresAt?.getTime() ?? null,
      ln: liveName,
      ra: nameContext.reason,
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
