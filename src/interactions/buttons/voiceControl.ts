import {
  type ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} from 'discord.js'
import { decodeVcId } from '../../utils/customId'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { canControlChannel, isSudo } from '../../services/voice/permissions'
import { postOrUpdateControlPanel, buildPanelPayloadForRecord } from '../../services/voice/controlPanel'
import { deleteAutoChannel } from '../../services/voice/autoChannel'

export async function handleVoiceControlButton(interaction: ButtonInteraction): Promise<void> {
  const decoded = decodeVcId(interaction.customId)
  if (!decoded) return

  const { voiceChannelId, action } = decoded

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) {
    await interaction.reply({ content: '❌ This channel no longer exists.', ephemeral: true })
    return
  }

  const member = await interaction.guild!.members.fetch(interaction.user.id)

  if (action === 'open_panel') {
    const payload = await buildPanelPayloadForRecord(interaction.client, record)
    await interaction.reply({
      ...payload,
      ephemeral: true,
    } as any)
    return
  }

  if (action === 'delete') {
    if (!canControlChannel(member, record) && !isSudo(member)) {
      await interaction.reply({ content: '❌ You do not have permission to delete this channel.', ephemeral: true })
      return
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`vc:${voiceChannelId}:delete_confirm`)
        .setLabel('Yes, delete it')
        .setStyle(ButtonStyle.Danger),
    )
    await interaction.reply({
      content: `⚠️ Are you sure you want to delete **this auto voice channel**? This cannot be undone.`,
      components: [row],
      ephemeral: true,
    })
    return
  }

  if (action === 'delete_confirm') {
    if (!canControlChannel(member, record) && !isSudo(member)) {
      await interaction.reply({ content: '❌ You do not have permission.', ephemeral: true })
      return
    }
    await interaction.deferReply({ ephemeral: true })
    await deleteAutoChannel(interaction.client, record)
    await interaction.editReply({ content: '✅ Channel deleted.' })
    return
  }

  if (action === 'rename') {
    if (!canControlChannel(member, record) && !isSudo(member)) {
      await interaction.reply({ content: '❌ You do not have permission to rename this channel.', ephemeral: true })
      return
    }
    const modal = new ModalBuilder()
      .setCustomId(`vc:${voiceChannelId}:rename`)
      .setTitle('Rename Channel')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('new_name')
            .setLabel('New channel name')
            .setStyle(TextInputStyle.Short)
            .setMinLength(1)
            .setMaxLength(100)
            .setRequired(true)
        )
      )
    await interaction.showModal(modal)
    return
  }

  if (action === 'lock' || action === 'unlock') {
    if (!canControlChannel(member, record) && !isSudo(member)) {
      await interaction.reply({ content: '❌ You do not have permission.', ephemeral: true })
      return
    }

    const isLocked = action === 'lock'
    const vc = await interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null)
    if (vc?.isVoiceBased()) {
      if (isLocked) {
        await vc.permissionOverwrites.edit(interaction.guild!.roles.everyone, { Connect: false }).catch(() => {})
      } else {
        await vc.permissionOverwrites.edit(interaction.guild!.roles.everyone, { Connect: null }).catch(() => {})
      }
    }

    await db.update(autoChannels).set({ isLocked }).where(eq(autoChannels.voiceChannelId, voiceChannelId))
    const updated = { ...record, isLocked }

    // Update the clicked panel directly via interaction.update so the button
    // changes immediately even if the user is clicking on a duplicate/stale panel
    const payload = await buildPanelPayloadForRecord(interaction.client, updated)
    await interaction.update({ ...payload, content: null } as any).catch(() => {})

    // Also sync the tracked panel if it's a different message (duplicate panels case)
    if (interaction.message.id !== record.controlPanelMsgId) {
      await postOrUpdateControlPanel(interaction.client, updated)
    }
    return
  }

  if (action === 'add_host') {
    if (!canControlChannel(member, record) && !isSudo(member)) {
      await interaction.reply({ content: '❌ You do not have permission.', ephemeral: true })
      return
    }
    const vc = await interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null)
    if (!vc?.isVoiceBased() || vc.members.size === 0) {
      await interaction.reply({ content: '❌ No members are in the channel to add as host.', ephemeral: true })
      return
    }
    const eligibleMembers = vc.members.filter(m => m.id !== record.ownerUserId && !record.hostUserIds.includes(m.id))
    if (eligibleMembers.size === 0) {
      await interaction.reply({ content: 'ℹ️ All current members are already hosts.', ephemeral: true })
      return
    }
    const options = eligibleMembers.first(25).map(m => ({ label: m.displayName, value: m.id }))
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`vc:${voiceChannelId}:add_host`)
        .setPlaceholder('Select a member to add as host')
        .addOptions(options)
    )
    await interaction.reply({ content: 'Choose a member to add as host:', components: [row], ephemeral: true })
    return
  }

  if (action === 'remove_host') {
    if (!canControlChannel(member, record) && !isSudo(member)) {
      await interaction.reply({ content: '❌ You do not have permission.', ephemeral: true })
      return
    }
    if (record.hostUserIds.length === 0) {
      await interaction.reply({ content: 'ℹ️ There are no hosts to remove.', ephemeral: true })
      return
    }
    const guild = interaction.guild!
    const options = await Promise.all(
      record.hostUserIds.slice(0, 25).map(async id => {
        const m = await guild.members.fetch(id).catch(() => null)
        return { label: m?.displayName ?? id, value: id }
      })
    )
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`vc:${voiceChannelId}:remove_host`)
        .setPlaceholder('Select a host to remove')
        .addOptions(options)
    )
    await interaction.reply({ content: 'Choose a host to remove:', components: [row], ephemeral: true })
    return
  }

  if (action === 'templates') {
    if (!canControlChannel(member, record) && !isSudo(member)) {
      await interaction.reply({ content: '❌ You do not have permission.', ephemeral: true })
      return
    }
    const vc = await interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null)
    const memberCount = vc?.isVoiceBased() ? vc.members.size : 1

    const generalSection = new ContainerBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('### 📋 General Templates')
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
      )

    const generalRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`vc:${voiceChannelId}:template_apply`)
        .setPlaceholder('Choose a template...')
        .addOptions([
          { label: '🎮 Auto — follows your game', value: 'auto', description: 'Renames to your active game via rich presence' },
          { label: `🔢 Counter — Game [${memberCount}/4]`, value: 'counter', description: 'Shows live member count in name' },
          { label: '🎯 Competitive 5-stack', value: 'comp5', description: 'Game from presence, limit 5' },
          { label: '🏆 Tryhard Mode', value: 'tryhard', description: 'Game + "Tryhard Mode", limit 5' },
          { label: '💬 Chill Session', value: 'chill', description: 'Chill vibes, no limit' },
        ])
    )

    const gameSection = new ContainerBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('### 🎮 Game Presets')
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
      )

    const gameRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`vc:${voiceChannelId}:template_apply`)
        .setPlaceholder('Overwatch or Rocket League...')
        .addOptions([
          { label: '⚔️ OW Ranked 5-Stack', value: 'ow_ranked', description: 'Overwatch Ranked [x/5]' },
          { label: '🎯 OW Quickplay', value: 'ow_quickplay', description: 'Overwatch Quickplay [x/5]' },
          { label: '🛡️ OW 6v6', value: 'ow_6v6', description: 'Overwatch 6v6 [x/6]' },
          { label: '🏟️ OW Scrimmage', value: 'ow_scrimmage', description: 'Overwatch Scrimmage [x/6]' },
          { label: '🚀 RL 3v3 Standard', value: 'rl_3v3', description: 'Rocket League [x/3]' },
          { label: '🚀 RL 2v2 Doubles', value: 'rl_2v2', description: 'Rocket League [x/2]' },
          { label: '🚀 RL 1v1 Duels', value: 'rl_1v1', description: 'Rocket League [x/2]' },
        ])
    )

    await interaction.reply({
      flags: MessageFlags.IsComponentsV2 as number,
      components: [generalSection, generalRow, gameSection, gameRow],
      ephemeral: true,
    } as any)
    return
  }

  if (action === 'claim') {
    const vc = await interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null)
    if (!vc?.isVoiceBased()) {
      await interaction.reply({ content: '❌ Voice channel not found.', ephemeral: true })
      return
    }
    const ownerPresent = vc.members.has(record.ownerUserId)
    if (ownerPresent && !isSudo(member)) {
      await interaction.reply({ content: '❌ The owner is still in the channel. You can only claim when they\'ve left.', ephemeral: true })
      return
    }
    if (!vc.members.has(member.id) && !isSudo(member)) {
      await interaction.reply({ content: '❌ You need to be in the voice channel to claim it.', ephemeral: true })
      return
    }
    const newHosts = record.hostUserIds.filter(id => id !== member.id)
    await db.update(autoChannels).set({ ownerUserId: member.id, hostUserIds: newHosts }).where(eq(autoChannels.voiceChannelId, voiceChannelId))
    const updated = { ...record, ownerUserId: member.id, hostUserIds: newHosts }

    const payload = await buildPanelPayloadForRecord(interaction.client, updated)
    await interaction.update({ ...payload, content: null } as any).catch(() => {})

    if (interaction.message.id !== record.controlPanelMsgId) {
      await postOrUpdateControlPanel(interaction.client, updated)
    }
    return
  }
}
