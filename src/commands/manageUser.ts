import {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  UserContextMenuCommandInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js'
import { db } from '../db/client'
import { autoChannels } from '../db/schema'
import { eq } from 'drizzle-orm'
import { isSudo } from '../services/voice/permissions'
import { sep } from '../utils/cv2'

export const data = new ContextMenuCommandBuilder()
  .setName('Manage User')
  .setType(ApplicationCommandType.User)
  .setDMPermission(false)

export async function execute(interaction: UserContextMenuCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const caller = await interaction.guild!.members.fetch(interaction.user.id)
  if (!isSudo(caller)) {
    await interaction.editReply({ content: '❌ Sudo access required.' })
    return
  }

  const target = await interaction.guild!.members.fetch(interaction.targetId)

  // Check if they own or are in any auto channel
  const [ownedChannel] = await db.select().from(autoChannels)
    .where(eq(autoChannels.ownerUserId, target.id))

  const voiceChannel = target.voice.channel
  const [currentChannel] = voiceChannel
    ? await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannel.id))
    : [undefined]

  const lines: string[] = [
    `**User:** ${target.displayName} (<@${target.id}>)`,
    `**Roles:** ${target.roles.cache.filter(r => r.id !== interaction.guild!.roles.everyone.id).map(r => r.name).join(', ') || 'none'}`,
    `**Voice:** ${voiceChannel ? `<#${voiceChannel.id}>${currentChannel ? ' (auto channel)' : ''}` : 'Not in voice'}`,
    `**Owns channel:** ${ownedChannel ? `<#${ownedChannel.voiceChannelId}>` : 'No'}`,
  ]

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 👤 Manage User`))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`sudo_user:edit_profile:${target.id}`)
      .setLabel('Edit Profile')
      .setEmoji('👤')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sudo_user:edit_games:${target.id}`)
      .setLabel('Game Prefs')
      .setEmoji('🎮')
      .setStyle(ButtonStyle.Primary),
    ...(currentChannel ? [
      new ButtonBuilder()
        .setCustomId(`sudo_user:force_panel:${target.id}`)
        .setLabel('View Channel Panel')
        .setEmoji('🎛️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sudo_user:kick_voice:${target.id}`)
        .setLabel('Disconnect from Voice')
        .setEmoji('🔇')
        .setStyle(ButtonStyle.Danger),
    ] : []),
    new ButtonBuilder()
      .setCustomId(`sudo_user:view_staff:${target.id}`)
      .setLabel('View Staff Record')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
  )

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: buttons.components.length > 0 ? [container, buttons] : [container],
  } as any)
}
