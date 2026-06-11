/**
 * #37 — Reaction-role service. Bot posts a message in a chosen channel,
 * adds the chosen emojis as initial reactions, and then watches for
 * user reactions to toggle roles.
 *
 * Temp mode: `expiresAt` set ⇒ the daily cleanup tick deletes the message
 * and clears the DB rows (and the bot tries to remove the granted roles
 * from anyone who currently holds them).
 */
import type { Client, Guild, TextChannel } from 'discord.js'
import { ChannelType } from 'discord.js'
import { db } from '../db/client'
import { reactionRoleMessages, reactionRoleMappings } from '../db/schema'
import { eq } from 'drizzle-orm'
import { logger } from './logger'

export interface ReactionRoleMapping {
  emoji: string  // unicode emoji OR custom emoji ID
  roleId: string
}

export interface ReactionRoleConfig {
  pk: string
  guildId: string
  channelId: string
  messageId: string
  anchorRoleId: string | null
  expiresAt: Date | null
  mappings: ReactionRoleMapping[]
}

const cache = new Map<string, ReactionRoleConfig>()  // keyed by messageId

export async function loadReactionRoles(): Promise<void> {
  // Query first, swap synchronously after — reloads triggered by the cache
  // invalidator must not blank the cache mid-query (reactions arriving in
  // that window would be silently ignored) or wipe it on a transient DB
  // error. On failure the previous cache stays live and the rejection
  // propagates to the caller's catch/log.
  const [msgs, maps] = await Promise.all([
    db.select().from(reactionRoleMessages),
    db.select().from(reactionRoleMappings),
  ])
  cache.clear()
  for (const m of msgs) {
    cache.set(m.messageId, {
      pk: m.id,
      guildId: m.guildId,
      channelId: m.channelId,
      messageId: m.messageId,
      anchorRoleId: m.anchorRoleId,
      expiresAt: m.expiresAt,
      mappings: maps.filter(mp => mp.messagePk === m.id).map(mp => ({ emoji: mp.emoji, roleId: mp.roleId })),
    })
  }
}

export function getReactionRoleConfig(messageId: string): ReactionRoleConfig | null {
  return cache.get(messageId) ?? null
}

export function listReactionRoles(): ReactionRoleConfig[] {
  return Array.from(cache.values())
}

/**
 * Create a new reaction-role message. Posts in `channel`, seeds each
 * mapping's emoji as an initial reaction so users have a click target.
 */
export async function createReactionRoleMessage(
  channel: TextChannel,
  body: string,
  mappings: ReactionRoleMapping[],
  opts: { anchorRoleId?: string | null; expiresAt?: Date | null; createdByUserId?: string },
): Promise<ReactionRoleConfig> {
  const sent = await channel.send({ content: body.slice(0, 2000), allowedMentions: { parse: [] } })

  const [row] = await db.insert(reactionRoleMessages).values({
    guildId: channel.guildId,
    channelId: channel.id,
    messageId: sent.id,
    anchorRoleId: opts.anchorRoleId ?? null,
    expiresAt: opts.expiresAt ?? null,
    createdByUserId: opts.createdByUserId ?? null,
  }).returning()

  for (const m of mappings) {
    await db.insert(reactionRoleMappings).values({ messagePk: row.id, emoji: m.emoji, roleId: m.roleId })
    await sent.react(m.emoji).catch(err => logger.warn(`reactionRoles: seed react ${m.emoji}: ${(err as Error).message}`))
  }

  const cfg: ReactionRoleConfig = {
    pk: row.id,
    guildId: channel.guildId,
    channelId: channel.id,
    messageId: sent.id,
    anchorRoleId: opts.anchorRoleId ?? null,
    expiresAt: opts.expiresAt ?? null,
    mappings,
  }
  cache.set(sent.id, cfg)
  return cfg
}

export async function deleteReactionRoleMessage(client: Client, messageId: string): Promise<void> {
  const cfg = cache.get(messageId)
  if (!cfg) return
  const guild = client.guilds.cache.get(cfg.guildId)
  if (guild) {
    const channel = guild.channels.cache.get(cfg.channelId)
    if (channel?.type === ChannelType.GuildText) {
      await (channel as TextChannel).messages.delete(cfg.messageId).catch(() => {})
    }
  }
  await db.delete(reactionRoleMappings).where(eq(reactionRoleMappings.messagePk, cfg.pk)).catch(() => {})
  await db.delete(reactionRoleMessages).where(eq(reactionRoleMessages.id, cfg.pk)).catch(() => {})
  cache.delete(messageId)
}

/**
 * Daily-ish cleanup tick — purge expired temp reaction-role messages and,
 * best-effort, strip the granted roles from members who still hold them.
 */
export async function cleanupExpiredReactionRoles(client: Client): Promise<number> {
  const now = new Date()
  const expired = listReactionRoles().filter(c => c.expiresAt && c.expiresAt <= now)
  let cleaned = 0
  for (const cfg of expired) {
    const guild = client.guilds.cache.get(cfg.guildId)
    if (guild) {
      for (const m of cfg.mappings) {
        // Strip the role from anyone who currently holds it.
        const members = guild.roles.cache.get(m.roleId)?.members
        if (members) {
          for (const member of members.values()) {
            await member.roles.remove(m.roleId, 'reaction-role temp expiry').catch(() => {})
          }
        }
      }
    }
    await deleteReactionRoleMessage(client, cfg.messageId)
    cleaned++
  }
  return cleaned
}

let cleanupTimer: NodeJS.Timeout | null = null
export function startReactionRoleCleanup(client: Client): void {
  if (cleanupTimer) clearInterval(cleanupTimer)
  // Run every 5 minutes — fast enough to feel real-time for game-night
  // expiries without spamming the DB.
  setTimeout(() => { void cleanupExpiredReactionRoles(client) }, 30_000)
  cleanupTimer = setInterval(() => { void cleanupExpiredReactionRoles(client) }, 5 * 60_000)
  logger.info('Reaction-role cleanup ticker started')
}
