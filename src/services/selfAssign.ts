/**
 * Self-assign role board.
 *
 * The bot posts one Components-V2 embed per configured entry into a single
 * channel (`selfassign.channel_id` in bot_settings), each carrying a toggle
 * button. Members click to add/remove a role (or, for games, to toggle channel
 * access + LFG pings) without an admin in the loop — "reaction roles, but one
 * embed + button per role".
 *
 * Two entry kinds:
 *   - 'role' : ref_id is a Discord role snowflake. One button toggles the role.
 *   - 'game' : ref_id is a games.id UUID. Up to two buttons toggle the game's
 *              channel View access and LFG ping role, wired through games.setPref.
 *
 * The catalog is small and read on every button click, so it lives in an
 * in-memory cache loaded at boot (ready.ts) and refreshed on every mutation.
 * All Discord side-effects (posting/editing/deleting messages, toggling roles)
 * are funnelled through here so the RPC handlers, the /sudo panel, and the
 * button handler share one implementation.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type MessageActionRowComponentBuilder,
  type TextChannel,
} from 'discord.js'
import { asc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { selfAssignEntries } from '../db/schema'
import { env } from '../config/env'
import { logger } from './logger'
import { clearSetting, getSetting, setSetting } from './settings'
import { getGame, matchedPingRoleId, matchedViewChannel } from './games'

export type SelfAssignEntry = typeof selfAssignEntries.$inferSelect

/** bot_settings key holding the destination channel for the board. */
export const SELF_ASSIGN_CHANNEL_KEY = 'selfassign.channel_id'

const SUPPRESS_NOTIFICATIONS = 1 << 12 // MessageFlags.SuppressNotifications

// ── in-memory cache ────────────────────────────────────────────────────────
let entriesCache: SelfAssignEntry[] = []
const enabledRoleRefs = new Set<string>()
const enabledGameRefs = new Set<string>()

function rebuildIndexes(): void {
  enabledRoleRefs.clear()
  enabledGameRefs.clear()
  for (const e of entriesCache) {
    if (!e.enabled) continue
    if (e.kind === 'role') enabledRoleRefs.add(e.refId)
    else if (e.kind === 'game') enabledGameRefs.add(e.refId)
  }
}

/** Load the board from the DB into the in-memory cache (boot + cache-invalidate). */
export async function loadSelfAssign(): Promise<void> {
  const rows = await db
    .select()
    .from(selfAssignEntries)
    .orderBy(asc(selfAssignEntries.sortOrder), asc(selfAssignEntries.createdAt))
  entriesCache = rows
  rebuildIndexes()
}

export function listEntries(): SelfAssignEntry[] {
  return [...entriesCache]
}

export function getEntry(id: string): SelfAssignEntry | null {
  return entriesCache.find((e) => e.id === id) ?? null
}

export function findEntryByRef(kind: 'role' | 'game', refId: string): SelfAssignEntry | null {
  return entriesCache.find((e) => e.kind === kind && e.refId === refId) ?? null
}

/** True when `roleId` is an enabled role entry — the button handler's allow-list. */
export function isEnabledRoleEntry(roleId: string): boolean {
  return enabledRoleRefs.has(roleId)
}

/** True when `gameId` is an enabled game entry — the button handler's allow-list. */
export function isEnabledGameEntry(gameId: string): boolean {
  return enabledGameRefs.has(gameId)
}

export function getChannelId(): string | null {
  return getSetting(SELF_ASSIGN_CHANNEL_KEY)
}

export async function setChannelId(channelId: string | null, byUserId?: string): Promise<void> {
  if (channelId) await setSetting(SELF_ASSIGN_CHANNEL_KEY, channelId, byUserId)
  else await clearSetting(SELF_ASSIGN_CHANNEL_KEY, byUserId)
}

// ── DB mutations (cache-refreshing; no Discord side-effects) ────────────────
function nextSortOrder(): number {
  return entriesCache.reduce((max, e) => Math.max(max, e.sortOrder), 0) + 1
}

export async function addEntry(input: {
  kind: 'role' | 'game'
  refId: string
  label?: string | null
  description?: string | null
  emoji?: string | null
  byUserId?: string | null
}): Promise<SelfAssignEntry> {
  const [row] = await db
    .insert(selfAssignEntries)
    .values({
      guildId: env.GUILD_ID,
      kind: input.kind,
      refId: input.refId,
      label: input.label ?? null,
      description: input.description ?? null,
      emoji: input.emoji ?? null,
      sortOrder: nextSortOrder(),
      enabled: true,
      createdByUserId: input.byUserId ?? null,
    })
    .returning()
  await loadSelfAssign()
  return row
}

export async function updateEntry(
  id: string,
  patch: Partial<Pick<SelfAssignEntry, 'label' | 'description' | 'emoji' | 'enabled' | 'sortOrder'>>,
): Promise<SelfAssignEntry | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() }
  if (patch.label !== undefined) set.label = patch.label
  if (patch.description !== undefined) set.description = patch.description
  if (patch.emoji !== undefined) set.emoji = patch.emoji
  if (patch.enabled !== undefined) set.enabled = patch.enabled
  if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder
  const [row] = await db
    .update(selfAssignEntries)
    .set(set)
    .where(eq(selfAssignEntries.id, id))
    .returning()
  await loadSelfAssign()
  return row ?? null
}

/** Delete the row. Returns the pre-delete row (with posted IDs) so the caller
 *  can remove its Discord message. */
export async function removeEntry(id: string): Promise<SelfAssignEntry | null> {
  const existing = getEntry(id)
  await db.delete(selfAssignEntries).where(eq(selfAssignEntries.id, id))
  await loadSelfAssign()
  return existing
}

export async function reorderEntries(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    await db
      .update(selfAssignEntries)
      .set({ sortOrder: i + 1, updatedAt: new Date() })
      .where(eq(selfAssignEntries.id, ids[i]))
  }
  await loadSelfAssign()
}

async function persistPosted(
  entry: SelfAssignEntry,
  channelId: string | null,
  messageId: string | null,
): Promise<void> {
  await db
    .update(selfAssignEntries)
    .set({ postedChannelId: channelId, postedMessageId: messageId, updatedAt: new Date() })
    .where(eq(selfAssignEntries.id, entry.id))
  entry.postedChannelId = channelId
  entry.postedMessageId = messageId
}

// ── rendering ───────────────────────────────────────────────────────────────
function applyButtonEmoji(button: ButtonBuilder, raw: string | null): void {
  if (!raw) return
  const custom = raw.match(/^<(a)?:([A-Za-z0-9_]+):(\d+)>$/)
  try {
    if (custom) button.setEmoji({ id: custom[3], name: custom[2], animated: Boolean(custom[1]) })
    else button.setEmoji(raw)
  } catch {
    // Ignore an unparseable emoji rather than blocking the whole post.
  }
}

/** Build the CV2 payload (single container card) for one board entry. */
export function buildEntryPayload(guild: Guild, entry: SelfAssignEntry): { flags: number; components: unknown[] } {
  const container = new ContainerBuilder().setAccentColor(0x5865f2)
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>()
  let hasButton = false

  if (entry.kind === 'role') {
    const role = guild.roles.cache.get(entry.refId)
    const name = entry.label?.trim() || role?.name || 'Unknown role'
    const lines = [`### ${name}`]
    if (entry.description?.trim()) lines.push(entry.description.trim())
    lines.push('_Use the button below to add or remove this role._')
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

    const btn = new ButtonBuilder()
      .setCustomId(`sar:role:${entry.refId}`)
      .setLabel('Add / Remove')
      .setStyle(ButtonStyle.Primary)
    applyButtonEmoji(btn, entry.emoji)
    row.addComponents(btn)
    hasButton = true
  } else {
    const game = getGame(entry.refId)
    const name = entry.label?.trim() || game?.name || 'Unknown game'
    const hasChannel = Boolean(game && matchedViewChannel(guild, game))
    const hasPing = Boolean(game && matchedPingRoleId(guild, game))
    const lines = [`### 🎮 ${name}`]
    if (entry.description?.trim()) lines.push(entry.description.trim())
    const toggles: string[] = []
    if (hasChannel) toggles.push('👁️ channel access')
    if (hasPing) toggles.push('🔔 LFG pings')
    lines.push(
      toggles.length
        ? `_Toggle ${toggles.join(' and ')} below._`
        : '_Not configured yet — ask an admin to set this game up._',
    )
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

    if (hasChannel) {
      const viewBtn = new ButtonBuilder()
        .setCustomId(`sar:gview:${entry.refId}`)
        .setLabel('Channel access')
        .setEmoji('👁️')
        .setStyle(ButtonStyle.Secondary)
      row.addComponents(viewBtn)
      hasButton = true
    }
    if (hasPing) {
      const pingBtn = new ButtonBuilder()
        .setCustomId(`sar:gping:${entry.refId}`)
        .setLabel('LFG pings')
        .setEmoji('🔔')
        .setStyle(ButtonStyle.Secondary)
      row.addComponents(pingBtn)
      hasButton = true
    }
  }

  if (hasButton) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
    )
    container.addActionRowComponents(row)
  }

  return {
    flags: (MessageFlags.IsComponentsV2 as number) | SUPPRESS_NOTIFICATIONS,
    components: [container],
  }
}

// ── Discord posting ──────────────────────────────────────────────────────────
async function resolveTextChannel(guild: Guild, channelId: string): Promise<TextChannel | null> {
  const cached: GuildBasedChannel | null =
    guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null))
  if (cached && cached.isTextBased() && 'send' in cached) return cached as TextChannel
  return null
}

/** Post (or edit-in-place) the entry's embed in `channelId`, persisting IDs. */
export async function postOrUpdateEntry(
  client: Client,
  guild: Guild,
  channelId: string,
  entry: SelfAssignEntry,
): Promise<void> {
  const channel = await resolveTextChannel(guild, channelId)
  if (!channel) {
    logger.warn(`selfAssign: post channel ${channelId} unavailable for entry ${entry.id}`)
    return
  }
  const payload = buildEntryPayload(guild, entry)

  if (entry.postedMessageId && entry.postedChannelId === channelId) {
    const existing = await channel.messages.fetch(entry.postedMessageId).catch(() => null)
    if (existing) {
      const err = await existing
        .edit(payload as never)
        .then(() => null)
        .catch((e) => e)
      if (err) logger.warn(`selfAssign: failed to edit message for entry ${entry.id}:`, err)
      return
    }
  }
  // Posted somewhere else previously — clean up the stale message first.
  if (entry.postedMessageId && entry.postedChannelId && entry.postedChannelId !== channelId) {
    await deleteEntryMessage(client, entry).catch(() => {})
  }

  const msg = await channel.send(payload as never).catch((e) => {
    logger.warn(`selfAssign: failed to post message for entry ${entry.id}:`, e)
    return null
  })
  if (!msg) return
  await persistPosted(entry, channelId, msg.id)
}

/** Delete the entry's live message (if any) and clear its persisted IDs. */
export async function deleteEntryMessage(client: Client, entry: SelfAssignEntry): Promise<void> {
  if (!entry.postedMessageId || !entry.postedChannelId) return
  const guild = client.guilds.cache.get(entry.guildId)
  const channel =
    (guild?.channels.cache.get(entry.postedChannelId) as GuildBasedChannel | undefined) ??
    (await client.channels.fetch(entry.postedChannelId).catch(() => null))
  if (channel && channel.isTextBased()) {
    await (channel as TextChannel).messages.delete(entry.postedMessageId).catch(() => {})
  }
  await persistPosted(entry, null, null)
}

/**
 * Full re-sync: wipe every tracked board message and repost all enabled entries
 * in sort order. This is the "Publish / Refresh" action — it guarantees the
 * channel reflects the configured order even after reorders/edits. No channel
 * set ⇒ just tears the board down. Returns counts for the caller's reply.
 */
export async function publishBoard(
  client: Client,
  guildId: string,
): Promise<{ posted: number; removed: number; channelId: string | null }> {
  const guild = client.guilds.cache.get(guildId)
  const channelId = getChannelId()
  if (!guild) return { posted: 0, removed: 0, channelId }

  let removed = 0
  for (const e of listEntries()) {
    if (e.postedMessageId) {
      await deleteEntryMessage(client, e)
      removed++
    }
  }

  if (!channelId) return { posted: 0, removed, channelId: null }
  const channel = await resolveTextChannel(guild, channelId)
  if (!channel) {
    logger.warn(`selfAssign: publish target ${channelId} unavailable`)
    return { posted: 0, removed, channelId }
  }

  let posted = 0
  for (const e of listEntries()) {
    if (!e.enabled) continue
    const msg = await channel.send(buildEntryPayload(guild, e) as never).catch((err) => {
      logger.warn(`selfAssign: failed to post entry ${e.id} during publish:`, err)
      return null
    })
    if (msg) {
      await persistPosted(e, channelId, msg.id)
      posted++
    }
  }
  logger.info(`selfAssign: published board — posted=${posted} removed=${removed} channel=${channelId}`)
  return { posted, removed, channelId }
}
