import type {
  ButtonInteraction, ChannelSelectMenuInteraction, GuildMember, ModalSubmitInteraction,
  OverwriteResolvable, RoleSelectMenuInteraction, StringSelectMenuInteraction,
  TextChannel, UserContextMenuCommandInteraction, UserSelectMenuInteraction, VoiceChannel,
} from 'discord.js'
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

type GuardableInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ChannelSelectMenuInteraction
  | UserSelectMenuInteraction
  | RoleSelectMenuInteraction
  | ModalSubmitInteraction
  | UserContextMenuCommandInteraction

/**
 * Guard a sudo-only interaction handler. Returns true if the caller may
 * proceed. On rejection, sends "❌ Sudo access required." ephemerally —
 * via reply() if the interaction hasn't been deferred yet, followUp()
 * otherwise — and returns false.
 */
export async function requireSudo(interaction: GuardableInteraction): Promise<boolean> {
  if (!interaction.guild) return false
  const member = await interaction.guild.members.fetch(interaction.user.id)
  if (isSudo(member)) return true
  const payload = { content: '❌ Sudo access required.', ephemeral: true } as const
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload).catch(() => {})
  } else if (interaction.isRepliable()) {
    await interaction.reply(payload).catch(() => {})
  }
  return false
}

export function isOwner(member: GuildMember, record: AutoChannelRecord): boolean {
  return member.id === record.ownerUserId
}

export function isHost(member: GuildMember, record: AutoChannelRecord): boolean {
  return record.hostUserIds.includes(member.id)
}

/**
 * True while the channel is in a grace window AND `member` is the acting
 * owner. False once grace expires (the actingOwnerUserId column is cleared
 * when the promotion happens, so this naturally goes false at expiry).
 */
export function isActingOwner(member: GuildMember, record: AutoChannelRecord): boolean {
  if (!record.actingOwnerUserId) return false
  return member.id === record.actingOwnerUserId
}

export function canControlChannel(member: GuildMember, record: AutoChannelRecord): boolean {
  return isSudo(member) || isOwner(member, record) || isHost(member, record) || isActingOwner(member, record)
}

export async function addMemberToTextChannel(textChannel: TextChannel, member: GuildMember): Promise<void> {
  // Cheap hot-path guard — voiceStateUpdate fires this on every voice join,
  // including repeat joins where the overwrite already exists. Skip the
  // Discord API call when the member already has the View+Send+History bits.
  const existing = textChannel.permissionOverwrites.cache.get(member.id)
  if (
    existing
    && existing.allow.has(PermissionFlagsBits.ViewChannel)
    && existing.allow.has(PermissionFlagsBits.SendMessages)
    && existing.allow.has(PermissionFlagsBits.ReadMessageHistory)
  ) return

  await textChannel.permissionOverwrites.create(member, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  }).catch(() => {})
}

export async function removeMemberFromTextChannel(textChannel: TextChannel, member: GuildMember): Promise<void> {
  // Skip the API call when there's nothing to remove.
  if (!textChannel.permissionOverwrites.cache.has(member.id)) return
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

  // Acting owner during grace — same text-channel perms as a host so they can
  // operate the panel and chat even if they momentarily step out of the VC.
  if (record.actingOwnerUserId && record.actingOwnerUserId !== record.ownerUserId) {
    overwrites.push({
      id: record.actingOwnerUserId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      type: OverwriteType.Member,
    })
  }

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
