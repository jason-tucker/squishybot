import type { GuildMember, VoiceChannel, TextChannel, OverwriteResolvable } from 'discord.js'
import { PermissionFlagsBits, OverwriteType } from 'discord.js'
import { env } from '../../config/env'
import type { AutoChannelRecord } from '../../types/voice'
import { isAdditionalSudo } from '../settings'

export function isSudo(member: GuildMember): boolean {
  if (env.SUDO_USER_IDS.includes(member.id)) return true
  if (env.SUDO_ROLE_IDS.some(roleId => member.roles.cache.has(roleId))) return true
  // Runtime additions via /sudo → Settings → Sudo Users (cached in memory).
  return isAdditionalSudo(member.id)
}

export function isOwner(member: GuildMember, record: AutoChannelRecord): boolean {
  return member.id === record.ownerUserId
}

export function isHost(member: GuildMember, record: AutoChannelRecord): boolean {
  return record.hostUserIds.includes(member.id)
}

export function canControlChannel(member: GuildMember, record: AutoChannelRecord): boolean {
  return isSudo(member) || isOwner(member, record) || isHost(member, record)
}

export async function addMemberToTextChannel(textChannel: TextChannel, member: GuildMember): Promise<void> {
  await textChannel.permissionOverwrites.create(member, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  }).catch(() => {})
}

export async function removeMemberFromTextChannel(textChannel: TextChannel, member: GuildMember): Promise<void> {
  await textChannel.permissionOverwrites.delete(member).catch(() => {})
}

export async function syncTextChannelPermissions(
  textChannel: TextChannel,
  voiceChannel: VoiceChannel,
  record: AutoChannelRecord,
  botId: string,
): Promise<void> {
  // Start fresh: deny everyone, allow bot
  const overwrites: OverwriteResolvable[] = [
    {
      id: textChannel.guild.roles.everyone,
      deny: [PermissionFlagsBits.ViewChannel],
      type: OverwriteType.Role,
    },
    {
      id: botId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory],
      type: OverwriteType.Member,
    },
  ]

  // Sudo roles
  for (const roleId of env.SUDO_ROLE_IDS) {
    overwrites.push({
      id: roleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory],
      type: OverwriteType.Role,
    })
  }

  // Owner
  overwrites.push({
    id: record.ownerUserId,
    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    type: OverwriteType.Member,
  })

  // Hosts
  for (const userId of record.hostUserIds) {
    overwrites.push({
      id: userId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      type: OverwriteType.Member,
    })
  }

  // Allowed users
  for (const userId of record.allowedUserIds) {
    overwrites.push({
      id: userId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      type: OverwriteType.Member,
    })
  }

  // Allowed roles
  for (const roleId of record.allowedRoleIds) {
    overwrites.push({
      id: roleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      type: OverwriteType.Role,
    })
  }

  // Current voice channel members
  for (const [, member] of voiceChannel.members) {
    if (!overwrites.some(o => o.id === member.id)) {
      overwrites.push({
        id: member.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        type: OverwriteType.Member,
      })
    }
  }

  await textChannel.permissionOverwrites.set(overwrites).catch(() => {})
}
