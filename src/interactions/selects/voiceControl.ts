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

  const selectedValue = interaction.values[0]

  if (action === 'hosts') {
    // Value is "add:userId" or "remove:userId"
    const [op, userId] = selectedValue.split(':', 2)
    if ((op !== 'add' && op !== 'remove') || !userId) {
      await interaction.reply({ content: '❌ Invalid selection.', ephemeral: true })
      return
    }

    await interaction.deferUpdate()

    const newHosts = op === 'add'
      ? [...record.hostUserIds, userId]
      : record.hostUserIds.filter(id => id !== userId)

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
      content: op === 'add'
        ? `✅ <@${userId}> is now a host.`
        : `✅ <@${userId}> is no longer a host.`,
      components: [],
    })
    return
  }
}
