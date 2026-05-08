import type { ModalSubmitInteraction } from 'discord.js'
import { decodeVcId } from '../../utils/customId'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { canControlChannel, isSudo } from '../../services/voice/permissions'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'
import { sanitizeChannelName } from '../../utils/channelName'

export async function handleVoiceRenameModal(interaction: ModalSubmitInteraction): Promise<void> {
  const decoded = decodeVcId(interaction.customId)
  if (!decoded || decoded.action !== 'rename') return

  const { voiceChannelId } = decoded

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) {
    await interaction.reply({ content: '❌ This channel no longer exists.', ephemeral: true })
    return
  }

  const member = await interaction.guild!.members.fetch(interaction.user.id)
  if (!canControlChannel(member, record) && !isSudo(member)) {
    await interaction.reply({ content: '❌ You do not have permission to rename this channel.', ephemeral: true })
    return
  }

  const rawName = interaction.fields.getTextInputValue('new_name')
  const newName = sanitizeChannelName(rawName)

  if (!newName) {
    await interaction.reply({ content: '❌ Invalid channel name.', ephemeral: true })
    return
  }

  // interaction.isFromMessage() → deferUpdate, else deferReply
  if (interaction.isFromMessage()) {
    await interaction.deferUpdate()
  } else {
    await interaction.deferReply({ ephemeral: true })
  }

  const [vc, tc] = await Promise.all([
    interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null),
    interaction.guild!.channels.fetch(record.textChannelId).catch(() => null),
  ])

  const textName = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice-chat'

  await Promise.all([
    vc?.isVoiceBased() ? vc.setName(newName).catch(() => {}) : Promise.resolve(),
    tc?.isTextBased() ? (tc as any).setName(textName).catch(() => {}) : Promise.resolve(),
  ])

  await db.update(autoChannels)
    .set({ manualName: newName, autoNameEnabled: false, fallbackName: newName })
    .where(eq(autoChannels.voiceChannelId, voiceChannelId))

  const updated = { ...record, manualName: newName, autoNameEnabled: false, fallbackName: newName }
  await postOrUpdateControlPanel(interaction.client, updated)

  if (interaction.isFromMessage()) {
    await interaction.editReply({ content: `✅ Channel renamed to **${newName}**.`, components: [] })
  } else {
    await interaction.editReply({ content: `✅ Channel renamed to **${newName}**.` })
  }
}
