import type { Client, GuildMember } from 'discord.js'
import { env } from '../../config/env'
import { restoreMemberPrefs } from '../../services/games'
import { logger } from '../../services/logger'
import { db } from '../../db/client'
import { autoJoinRoles } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { getBoolSetting, getSetting } from '../../services/settings'
import { publish, memberCh, type MemberJoinedGuildEvent } from '../../services/eventBus'

/**
 * On guildMemberAdd we re-apply every persisted game pref for the member.
 * Discord drops their roles and channel-overwrites when they leave the
 * server, so without this their /games selections silently stop applying
 * the moment they rejoin. The DB row is the source of truth; this just
 * brings Discord back in sync.
 *
 * Also applies any configured auto-join roles when the feature flag is on.
 */
export function registerGuildMemberAdd(client: Client): void {
  client.on('guildMemberAdd', async (member: GuildMember) => {
    if (member.guild.id !== env.GUILD_ID) return
    if (member.user.bot) return

    void publish<MemberJoinedGuildEvent>(memberCh('joined_guild'), {
      userId: member.id, ts: new Date().toISOString(),
    })

    // #20 — Welcome message. Default OFF.
    if (getBoolSetting('welcome.enabled', false)) {
      try {
        const channelId = getSetting('welcome.channel_id')
        const template = getSetting('welcome.template') ?? '👋 Welcome {user} to {server}! We\'re now at {member_count} members.'
        if (channelId) {
          const channel = member.guild.channels.cache.get(channelId)
            ?? await member.guild.channels.fetch(channelId).catch(() => null)
          if (channel?.isTextBased()) {
            const text = template
              .replace(/\{user\}/g, `<@${member.id}>`)
              .replace(/\{server\}/g, member.guild.name)
              .replace(/\{member_count\}/g, String(member.guild.memberCount))
              .replace(/\{account_age\}/g, `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`)
              .slice(0, 2000)
            await (channel as any).send({ content: text, allowedMentions: { users: [member.id] } }).catch((err: unknown) =>
              logger.warn(`welcome: failed to post in ${channelId}: ${(err as Error).message}`),
            )
          }
        }
      } catch (err) {
        logger.warn(`guildMemberAdd: welcome failed for ${member.id}:`, err)
      }
    }

    // #36 — Apply configured auto-roles. Default OFF via feature flag.
    if (getBoolSetting('feature.auto_role_on_join', false)) {
      try {
        const rows = await db.select().from(autoJoinRoles).where(eq(autoJoinRoles.guildId, member.guild.id))
        for (const r of rows) {
          await member.roles.add(r.roleId, 'auto-role on join').catch(err =>
            logger.warn(`auto-role: failed to add ${r.roleId} to ${member.id}: ${(err as Error).message}`),
          )
        }
        if (rows.length > 0) logger.info(`Auto-role applied ${rows.length} role(s) to ${member.id}`)
      } catch (err) {
        logger.warn(`guildMemberAdd: auto-role failed for ${member.id}:`, err)
      }
    }

    try {
      const result = await restoreMemberPrefs(member)
      if (result.restored === 0) return  // no prior prefs — quiet path
    } catch (err) {
      logger.warn(`guildMemberAdd: failed to restore prefs for ${member.id}:`, err)
    }
  })
}
