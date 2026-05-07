import type { Client, GuildMember } from 'discord.js'
import { env } from '../../config/env'
import { restoreMemberPrefs } from '../../services/games'
import { logger } from '../../services/logger'

/**
 * On guildMemberAdd we re-apply every persisted game pref for the member.
 * Discord drops their roles and channel-overwrites when they leave the
 * server, so without this their /games selections silently stop applying
 * the moment they rejoin. The DB row is the source of truth; this just
 * brings Discord back in sync.
 */
export function registerGuildMemberAdd(client: Client): void {
  client.on('guildMemberAdd', async (member: GuildMember) => {
    if (member.guild.id !== env.GUILD_ID) return
    if (member.user.bot) return

    try {
      const result = await restoreMemberPrefs(member)
      if (result.restored === 0) return  // no prior prefs — quiet path
    } catch (err) {
      logger.warn(`guildMemberAdd: failed to restore prefs for ${member.id}:`, err)
    }
  })
}
