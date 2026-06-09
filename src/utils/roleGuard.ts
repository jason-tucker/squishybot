/**
 * Shared guard for "is this role safe for the bot to grant to a member via a
 * self-service / panel-driven path?".
 *
 * Several code paths call `member.roles.add(...)` with a role id that ultimately
 * comes from member-supplied or wire-supplied input — the `/color` picker
 * (`StringSelectMenuInteraction.values`), reaction-role creation over the RPC
 * bus, and the reaction-role grant sink. None of those should ever be coercible
 * into handing out a *privileged* role (privilege escalation — see
 * security-review/SECURITY_REVIEW_REPORT.md findings H1/H2). This module is the
 * single chokepoint they all funnel through.
 */
import type { Guild, Role } from 'discord.js'
import { PermissionsBitField } from 'discord.js'

/**
 * Permissions that make a role "privileged". Granting any of these through an
 * unprivileged, self-service path is an escalation, so we refuse to auto-assign
 * a role that carries one. Intentionally broad (all management + moderation
 * perms): curated cosmetic / game / reaction roles never carry these.
 */
const PRIVILEGED_PERMISSIONS = new PermissionsBitField([
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'ManageWebhooks',
  'ManageGuildExpressions',
  'ManageEvents',
  'ManageMessages',
  'ManageNicknames',
  'ManageThreads',
  'KickMembers',
  'BanMembers',
  'ModerateMembers',
  'MentionEveryone',
  'ViewAuditLog',
])

export type RoleAssignVerdict =
  | { ok: true; role: Role }
  | { ok: false; reason: 'everyone' | 'not-found' | 'managed' | 'privileged' | 'above-bot'; role?: Role }

/**
 * Decide whether the bot may grant `roleId` in `guild` through a self-service
 * path. Rejects:
 *  - `@everyone` (`roleId === guild.id`)
 *  - managed / integration roles (bot roles, the booster role, …) — Discord
 *    forbids manual assignment anyway, but we surface a clean refusal
 *  - any role carrying a privileged permission (admin / mod / manage-*)
 *  - any role at or above the bot's own highest role (Discord would reject the
 *    `roles.add` regardless, but failing fast avoids a confusing partial state)
 */
export function checkAssignableRole(guild: Guild, roleId: string): RoleAssignVerdict {
  if (roleId === guild.id) return { ok: false, reason: 'everyone' }
  const role = guild.roles.cache.get(roleId)
  if (!role) return { ok: false, reason: 'not-found' }
  if (role.managed) return { ok: false, reason: 'managed', role }
  if (role.permissions.any(PRIVILEGED_PERMISSIONS)) return { ok: false, reason: 'privileged', role }
  const me = guild.members.me
  if (me && role.comparePositionTo(me.roles.highest) >= 0) return { ok: false, reason: 'above-bot', role }
  return { ok: true, role }
}

/** Convenience boolean wrapper around {@link checkAssignableRole}. */
export function isAssignableRole(guild: Guild, roleId: string): boolean {
  return checkAssignableRole(guild, roleId).ok
}
