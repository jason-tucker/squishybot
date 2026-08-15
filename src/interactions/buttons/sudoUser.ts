import {
  type ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} from 'discord.js'
import { db } from '../../db/client'
import { autoChannels, staffApprovals } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { requireSudo } from '../../services/voice/permissions'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'
import { sep } from '../../utils/cv2'

export async function handleSudoUserButton(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(':')
  if (parts[0] !== 'sudo_user') return

  if (!await requireSudo(interaction)) return
  const caller = await interaction.guild!.members.fetch(interaction.user.id)

  const action = parts[1]
  const targetId = parts[2]

  if (action === 'force_panel') {
    // The Manage User panel is CV2 — editReply with content is rejected
    // (50035). Status lines go via ephemeral followUp; the panel stays up.
    await interaction.deferUpdate()
    const target = await interaction.guild!.members.fetch(targetId).catch(() => null)
    const voiceChannelId = target?.voice.channelId
    if (!voiceChannelId) {
      await interaction.followUp({ content: 'User is not in a voice channel.', ephemeral: true })
      return
    }
    const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
    if (!record) {
      await interaction.followUp({ content: 'Not in an auto channel.', ephemeral: true })
      return
    }
    await postOrUpdateControlPanel(interaction.client, record)
    await interaction.followUp({ content: '✅ Panel refreshed in their text channel.', ephemeral: true })
    return
  }

  if (action === 'kick_voice') {
    await interaction.deferUpdate()
    const target = await interaction.guild!.members.fetch(targetId).catch(() => null)
    if (!target?.voice.channel) {
      await interaction.followUp({ content: 'User is not in a voice channel.', ephemeral: true })
      return
    }
    await target.voice.disconnect(`Disconnected by sudo: ${caller.displayName}`)
    await interaction.followUp({ content: `✅ Disconnected ${target.displayName} from voice.`, ephemeral: true })
    return
  }

  if (action === 'edit_profile') {
    await interaction.deferUpdate()
    const target = await interaction.guild!.members.fetch(targetId).catch(() => null)
    const name = target?.displayName ?? `<@${targetId}>`
    const { renderProfileEditor } = await import('../profileEditor')
    const payload = await renderProfileEditor(interaction.guildId!, targetId, name, 'sudo')
    await interaction.editReply(payload as any)
    return
  }

  if (action === 'edit_games') {
    await interaction.deferUpdate()
    const { renderPrefsEditor } = await import('../gamesEditor')
    const payload = await renderPrefsEditor(interaction.guild!, targetId, 'sudo')
    await interaction.editReply(payload as any)
    return
  }

  if (action === 'view_staff') {
    await interaction.deferUpdate()
    const records = await db.select().from(staffApprovals).where(eq(staffApprovals.userId, targetId))
    const recent = records.slice(-5).reverse()
    const body = recent.length === 0
      ? '_No staff request history._'
      : recent.map(r => {
          const data = r.requestedData as Record<string, unknown>
          const summary = Object.entries(data).filter(([, v]) => v).map(([k, v]) => `${k}: \`${v}\``).join(', ')
          return `**${r.status.toUpperCase()}** — ${summary}\n${r.reviewedBy ? `-# Reviewed by <@${r.reviewedBy}>` : '-# Pending'}`
        }).join('\n\n')

    const container = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📋 Staff Record — <@${targetId}>`))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))

    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`sudo_user:back:${targetId}`).setLabel('Back').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
    )
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container, backRow],
    } as any)
    return
  }

  if (action === 'back') {
    await interaction.deferUpdate()
    const { renderManagePanel } = await import('../../commands/manageUser')
    const payload = await renderManagePanel(interaction.guild!, targetId)
    await interaction.editReply(payload as any)
    return
  }
}
