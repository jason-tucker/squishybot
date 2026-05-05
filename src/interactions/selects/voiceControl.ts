import type { StringSelectMenuInteraction } from 'discord.js'
import { decodeVcId } from '../../utils/customId'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { canControlChannel, isSudo, syncTextChannelPermissions } from '../../services/voice/permissions'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'

export async function handleVoiceControlSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const decoded = decodeVcId(interaction.customId)
  if (!decoded) return

  const { voiceChannelId, action } = decoded

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) {
    await interaction.reply({ content: '❌ This channel no longer exists.', ephemeral: true })
    return
  }

  const member = await interaction.guild!.members.fetch(interaction.user.id)
  if (!canControlChannel(member, record) && !isSudo(member)) {
    await interaction.reply({ content: '❌ You do not have permission.', ephemeral: true })
    return
  }

  const selectedId = interaction.values[0]

  if (action === 'add_host') {
    await interaction.deferUpdate()
    const newHosts = [...record.hostUserIds, selectedId]
    await db.update(autoChannels).set({ hostUserIds: newHosts }).where(eq(autoChannels.voiceChannelId, voiceChannelId))

    // Update text channel permissions
    const [vc, tc] = await Promise.all([
      interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null),
      interaction.guild!.channels.fetch(record.textChannelId).catch(() => null),
    ])
    if (vc?.isVoiceBased() && tc?.isTextBased()) {
      await syncTextChannelPermissions(tc as any, vc as any, { ...record, hostUserIds: newHosts }, interaction.client.user!.id)
    }
    const updated = { ...record, hostUserIds: newHosts }
    await postOrUpdateControlPanel(interaction.client, updated)

    await interaction.editReply({
      content: `✅ <@${selectedId}> is now a host.`,
      components: [],
    })
    return
  }

  if (action === 'remove_host') {
    await interaction.deferUpdate()
    const newHosts = record.hostUserIds.filter(id => id !== selectedId)
    await db.update(autoChannels).set({ hostUserIds: newHosts }).where(eq(autoChannels.voiceChannelId, voiceChannelId))

    const [vc, tc] = await Promise.all([
      interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null),
      interaction.guild!.channels.fetch(record.textChannelId).catch(() => null),
    ])
    if (vc?.isVoiceBased() && tc?.isTextBased()) {
      await syncTextChannelPermissions(tc as any, vc as any, { ...record, hostUserIds: newHosts }, interaction.client.user!.id)
    }
    const updated = { ...record, hostUserIds: newHosts }
    await postOrUpdateControlPanel(interaction.client, updated)

    await interaction.editReply({
      content: `✅ <@${selectedId}> is no longer a host.`,
      components: [],
    })
    return
  }
}
