import { SlashCommandBuilder, ChatInputCommandInteraction, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags } from 'discord.js'
import { db } from '../db/client'
import { autoChannels } from '../db/schema'
import { eq } from 'drizzle-orm'
import { isSudo, canControlChannel } from '../services/voice/permissions'

export const data = new SlashCommandBuilder()
  .setName('voice')
  .setDescription('Auto voice channel controls')
  .setDMPermission(false)
  .addSubcommand(sub =>
    sub.setName('panel').setDescription('Open the control panel for your active voice channel')
  )
  .addSubcommand(sub =>
    sub.setName('claim').setDescription('Claim ownership of an unclaimed auto channel')
  )
  .addSubcommand(sub =>
    sub.setName('delete').setDescription('Delete your auto voice channel')
  )

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand()

  // Find the auto channel the user is currently in
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const voiceChannelId = member.voice.channelId

  // Fetch auto channel record if the user is in a voice channel
  const record = voiceChannelId
    ? (await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId)))[0] ?? null
    : null

  if (sub === 'panel') {
    if (!record) {
      await interaction.reply({
        content: '❌ You need to be in an auto voice channel to use this command.',
        ephemeral: true,
      })
      return
    }

    if (!canControlChannel(member, record) && !isSudo(member)) {
      await interaction.reply({
        content: '❌ You need to be the owner or a host of this channel.',
        ephemeral: true,
      })
      return
    }

    await interaction.deferReply({ ephemeral: true })
    const { postOrUpdateControlPanel } = await import('../services/voice/controlPanel')
    const textChannel = await interaction.guild!.channels.fetch(record.textChannelId).catch(() => null)
    if (textChannel?.isTextBased()) {
      await postOrUpdateControlPanel(interaction.client, record)
      await interaction.editReply({ content: '✅ Control panel updated in your voice text channel.' })
    } else {
      await interaction.editReply({ content: '❌ Could not find the attached text channel.' })
    }
    return
  }

  if (sub === 'claim') {
    if (!record) {
      await interaction.reply({
        content: '❌ You need to be in an auto voice channel to claim it.',
        ephemeral: true,
      })
      return
    }

    // Check that the current owner is NOT in the voice channel
    const vc = await interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null)
    if (!vc?.isVoiceBased()) {
      await interaction.reply({ content: '❌ Voice channel not found.', ephemeral: true })
      return
    }
    const ownerStillPresent = vc.members.has(record.ownerUserId)
    if (ownerStillPresent && !isSudo(member)) {
      await interaction.reply({
        content: '❌ The channel owner is still present. You can only claim an unclaimed channel.',
        ephemeral: true,
      })
      return
    }

    await db.update(autoChannels)
      .set({ ownerUserId: member.id, hostUserIds: record.hostUserIds.filter(id => id !== member.id) })
      .where(eq(autoChannels.voiceChannelId, voiceChannelId!))

    const updatedRecord = { ...record, ownerUserId: member.id }
    const { postOrUpdateControlPanel } = await import('../services/voice/controlPanel')
    await postOrUpdateControlPanel(interaction.client, updatedRecord)

    await interaction.reply({
      content: `✅ You are now the owner of **${vc.name}**.`,
      ephemeral: true,
    })
    return
  }

  if (sub === 'delete') {
    if (!record) {
      await interaction.reply({
        content: '❌ You need to be in an auto voice channel to delete it.',
        ephemeral: true,
      })
      return
    }

    if (!canControlChannel(member, record) && !isSudo(member)) {
      await interaction.reply({
        content: '❌ You need to be the owner or a host to delete this channel.',
        ephemeral: true,
      })
      return
    }

    await interaction.deferReply({ ephemeral: true })
    const { deleteAutoChannel } = await import('../services/voice/autoChannel')
    await deleteAutoChannel(interaction.client, record)
    await interaction.editReply({ content: '✅ Channel deleted.' })
  }
}
