import type { Client, GuildMember, PartialGuildMember } from 'discord.js'
import { env } from '../../config/env'
import { getBoolSetting, getSetting } from '../../services/settings'
import { logger } from '../../services/logger'

/**
 * #20 — Goodbye message on guildMemberRemove. Default OFF.
 * Same token substitution as the welcome path; {account_age} works only if
 * Discord delivered a non-partial member.
 */
export function registerGuildMemberRemove(client: Client): void {
  client.on('guildMemberRemove', async (member: GuildMember | PartialGuildMember) => {
    if (member.guild.id !== env.GUILD_ID) return
    if (member.user?.bot) return
    if (!getBoolSetting('goodbye.enabled', false)) return

    const channelId = getSetting('goodbye.channel_id')
    if (!channelId) return
    const channel = member.guild.channels.cache.get(channelId)
      ?? await member.guild.channels.fetch(channelId).catch(() => null)
    if (!channel?.isTextBased()) return

    const template = getSetting('goodbye.template') ?? '👋 {user} has left {server}. We\'re now at {member_count} members.'
    const text = template
      .replace(/\{user\}/g, member.user ? `**${member.user.tag}**` : `<@${member.id}>`)
      .replace(/\{server\}/g, member.guild.name)
      .replace(/\{member_count\}/g, String(member.guild.memberCount))
      .slice(0, 2000)
    // Don't ping anyone on goodbye — the user has already left, and the
    // client-wide allowedMentions default is { parse: [] } anyway.
    await (channel as any).send({ content: text }).catch((err: unknown) =>
      logger.warn(`goodbye: failed to post in ${channelId}: ${(err as Error).message}`),
    )
  })
}
