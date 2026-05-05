import {
  type ButtonInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} from 'discord.js'
import { db } from '../../db/client'
import { autoChannels, staffApprovals } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { isSudo } from '../../services/voice/permissions'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'

export async function handleSudoUserButton(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(':')
  if (parts[0] !== 'sudo_user') return

  const caller = await interaction.guild!.members.fetch(interaction.user.id)
  if (!isSudo(caller)) {
    await interaction.reply({ content: '❌ Sudo access required.', ephemeral: true })
    return
  }

  const action = parts[1]
  const targetId = parts[2]

  if (action === 'force_panel') {
    await interaction.deferUpdate()
    const target = await interaction.guild!.members.fetch(targetId).catch(() => null)
    const voiceChannelId = target?.voice.channelId
    if (!voiceChannelId) {
      await interaction.editReply({ content: 'User is not in a voice channel.' })
      return
    }
    const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
    if (!record) {
      await interaction.editReply({ content: 'Not in an auto channel.' })
      return
    }
    await postOrUpdateControlPanel(interaction.client, record)
    await interaction.editReply({ content: '✅ Panel refreshed in their text channel.' })
    return
  }

  if (action === 'kick_voice') {
    await interaction.deferUpdate()
    const target = await interaction.guild!.members.fetch(targetId).catch(() => null)
    if (!target?.voice.channel) {
      await interaction.editReply({ content: 'User is not in a voice channel.' })
      return
    }
    await target.voice.disconnect(`Disconnected by sudo: ${caller.displayName}`)
    await interaction.editReply({ content: `✅ Disconnected ${target.displayName} from voice.` })
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
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))

    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    } as any)
    return
  }
}
