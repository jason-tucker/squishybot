import {
  type ButtonInteraction,
  type GuildMember,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} from 'discord.js'
import { decodeVcId } from '../../utils/customId'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { canControlChannel, isSudo } from '../../services/voice/permissions'
import { postOrUpdateControlPanel, buildPanelPayloadForRecord } from '../../services/voice/controlPanel'
import { deleteAutoChannel } from '../../services/voice/autoChannel'
import { sep } from '../../utils/cv2'

type AutoChannelRecord = typeof autoChannels.$inferSelect

/**
 * Verifies that `member` may control `record`. If not, replies with an
 * ephemeral error and returns false. The caller should `return` immediately
 * when this returns false.
 */
async function requireControl(
  interaction: ButtonInteraction,
  member: GuildMember,
  record: AutoChannelRecord,
  message = '❌ You do not have permission.',
): Promise<boolean> {
  if (canControlChannel(member, record) || isSudo(member)) return true
  await interaction.reply({ content: message, ephemeral: true })
  return false
}

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
    if (!await requireControl(interaction, member, record, '❌ You do not have permission to delete this channel.')) return
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
    if (!await requireControl(interaction, member, record)) return
    await interaction.deferReply({ ephemeral: true })
    await deleteAutoChannel(interaction.client, record)
    await interaction.editReply({ content: '✅ Channel deleted.' })
    return
  }

  if (action === 'rename') {
    if (!await requireControl(interaction, member, record, '❌ You do not have permission to rename this channel.')) return
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
    if (!await requireControl(interaction, member, record)) return

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

  if (action === 'hosts') {
    if (!await requireControl(interaction, member, record)) return
    const guild = interaction.guild!
    const vc = await guild.channels.fetch(record.voiceChannelId).catch(() => null)

    // Build one combined select: current hosts (❌ remove) + VC members not owner/host (👑 add)
    const options: { label: string; value: string; description?: string }[] = []

    for (const hostId of record.hostUserIds.slice(0, 24)) {
      const m = await guild.members.fetch(hostId).catch(() => null)
      options.push({
        label: `❌ Remove — ${m?.displayName ?? hostId}`,
        value: `remove:${hostId}`,
        description: 'Click to remove host status',
      })
    }

    if (vc?.isVoiceBased()) {
      const eligible = vc.members.filter(m => m.id !== record.ownerUserId && !record.hostUserIds.includes(m.id))
      for (const m of eligible.first(24 - options.length)) {
        options.push({
          label: `👑 Add — ${m.displayName}`,
          value: `add:${m.id}`,
          description: 'Click to make this member a host',
        })
      }
    }

    if (options.length === 0) {
      await interaction.reply({
        content: 'ℹ️ No hosts to remove and no eligible members to add. (Only members currently in the voice channel can be added as hosts.)',
        ephemeral: true,
      })
      return
    }

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`vc:${voiceChannelId}:hosts`)
        .setPlaceholder('Add or remove a host…')
        .addOptions(options)
    )
    await interaction.reply({
      content: '**Hosts**\nPick a member to toggle their host status:',
      components: [row],
      ephemeral: true,
    })
    return
  }

  if (action === 'templates') {
    if (!await requireControl(interaction, member, record)) return
    const vc = await interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null)
    const memberCount = vc?.isVoiceBased() ? vc.members.size : 1

    const header = new ContainerBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '### 📋 Templates\n_Auto detects what you\'re playing from your rich presence._'
        )
      )
      .addSeparatorComponents(sep())

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`vc:${voiceChannelId}:template_apply`)
        .setPlaceholder('Choose a template...')
        .addOptions([
          { label: '🎮 Auto — follows your game', value: 'auto', description: 'Detects game + OW/RL mode from rich presence' },
          { label: `🔢 Counter — [${memberCount}/4]`, value: 'counter', description: 'Live member count in name' },
          { label: '🎯 Competitive 5-stack', value: 'comp5', description: 'Limit 5' },
          { label: '🏆 Tryhard Mode', value: 'tryhard', description: 'Limit 5' },
          { label: '💬 Chill Session', value: 'chill', description: 'No limit' },
        ])
    )

    await interaction.reply({
      flags: MessageFlags.IsComponentsV2 as number,
      components: [header, row],
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
