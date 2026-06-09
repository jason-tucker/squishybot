/**
 * #37 — Message reaction → role toggle.
 *
 * The bot watches messages whose IDs are in the reaction-role cache. When
 * a non-bot reaction is added or removed, we look up the matching mapping
 * and grant / strip the role on the reacting member.
 */
import type { Client, MessageReaction, PartialMessageReaction, User, PartialUser } from 'discord.js'
import { getReactionRoleConfig } from '../../services/reactionRoles'
import { checkAssignableRole } from '../../utils/roleGuard'
import { logger } from '../../services/logger'

function emojiKey(r: MessageReaction | PartialMessageReaction): string {
  // Custom emojis have a numeric `id`; unicode emojis don't (we use the name).
  return r.emoji.id ?? r.emoji.name ?? ''
}

async function apply(client: Client, reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, add: boolean): Promise<void> {
  if (user.bot) return
  if (!reaction.message.guildId) return

  // Fetch any partials so .guildId / .emoji / .members work reliably.
  if (reaction.partial) {
    try { await reaction.fetch() } catch { return }
  }
  if (user.partial) {
    try { await user.fetch() } catch { return }
  }

  const cfg = getReactionRoleConfig(reaction.message.id)
  if (!cfg) return

  const key = emojiKey(reaction)
  const mapping = cfg.mappings.find(m => m.emoji === key)
  if (!mapping) return

  const guild = client.guilds.cache.get(reaction.message.guildId)
  if (!guild) return
  const member = await guild.members.fetch(user.id).catch(() => null)
  if (!member) return

  try {
    if (add) {
      // SECURITY (H2): the mapping's roleId can originate from the RPC bus
      // (`rxnroles.create`) where only its snowflake *shape* was validated. This
      // is the actual grant sink, so re-check assignability here — never hand a
      // member a privileged / managed / @everyone role via a reaction. (Removal
      // is always allowed: stripping a role is never an escalation.)
      const verdict = checkAssignableRole(guild, mapping.roleId)
      if (!verdict.ok) {
        logger.warn(`reaction-role: refusing to grant non-assignable role ${mapping.roleId} (${verdict.reason}) to ${user.id}`)
        return
      }
      await member.roles.add(mapping.roleId, 'reaction-role')
    } else {
      await member.roles.remove(mapping.roleId, 'reaction-role')
    }
  } catch (err) {
    logger.warn(`reaction-role ${add ? 'add' : 'remove'} failed for ${user.id} → ${mapping.roleId}: ${(err as Error).message}`)
  }
}

export function registerMessageReaction(client: Client): void {
  client.on('messageReactionAdd', (reaction, user) => { void apply(client, reaction, user, true) })
  client.on('messageReactionRemove', (reaction, user) => { void apply(client, reaction, user, false) })
}
