import type { StringSelectMenuInteraction } from 'discord.js'
import { decodeVcId } from '../../utils/customId'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { canControlChannel, isOwner, isSudo } from '../../services/voice/permissions'
import { toggleHost } from '../../services/voice/hostsService'

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
  // Hosts management is owner-or-sudo only — the acting owner during a grace
  // window can't unseat the original owner or other hosts. Other actions on
  // this handler still use the broader canControlChannel gate.
  const guardOk = action === 'hosts'
    ? (isOwner(member, record) || isSudo(member))
    : (canControlChannel(member, record) || isSudo(member))
  if (!guardOk) {
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

    const result = await toggleHost({
      client: interaction.client,
      voiceChannelId,
      userId,
      op,
    })

    if (!result.ok) {
      await interaction.editReply({
        content: `❌ ${result.error}${result.details ? `: ${result.details}` : ''}`,
        components: [],
      })
      return
    }

    await interaction.editReply({
      content: op === 'add'
        ? `✅ <@${userId}> is now a host.`
        : `✅ <@${userId}> is no longer a host.`,
      components: [],
    })
    return
  }
}
