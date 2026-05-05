import {
  type ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} from 'discord.js'
import { decodeVcId } from '../../utils/customId'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { canControlChannel, isSudo } from '../../services/voice/permissions'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'
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
    await interaction.deferUpdate()
    await deleteAutoChannel(interaction.client, record)
    await interaction.editReply({ content: '✅ Channel deleted.', components: [] })
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
    await interaction.deferUpdate()

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
    await postOrUpdateControlPanel(interaction.client, updated)
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
}
