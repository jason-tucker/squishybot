import type { ModalSubmitInteraction } from 'discord.js'
import { decodeVcId } from '../../utils/customId'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { canControlChannel, isSudo } from '../../services/voice/permissions'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'
import { maybeRenameChannel } from '../../services/voice/autoRename'
import { sanitizeChannelName } from '../../utils/channelName'
import { decorateChannelName } from '../../services/voice/autoNaming'

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

  // interaction.isFromMessage() → deferUpdate, else deferReply
  if (interaction.isFromMessage()) {
    await interaction.deferUpdate()
  } else {
    await interaction.deferReply({ ephemeral: true })
  }

  // Blank rename → hand control back to Smart auto-naming. The name is no
  // longer frozen; the next presence/voice change (or the immediate
  // maybeRenameChannel below) re-derives it.
  if (!rawName.trim()) {
    await db.update(autoChannels)
      .set({ autoNameEnabled: true, nameTemplate: 'auto', manualName: null })
      .where(eq(autoChannels.voiceChannelId, voiceChannelId))
    const reverted = { ...record, autoNameEnabled: true, nameTemplate: 'auto', manualName: null }
    await maybeRenameChannel(interaction.client, reverted)
    await postOrUpdateControlPanel(interaction.client, reverted)
    const msg = '✅ Auto-naming is back **on** (Smart) — the room will follow whatever game 2+ people are playing.'
    if (interaction.isFromMessage()) {
      await interaction.editReply({ content: msg, components: [] })
    } else {
      await interaction.editReply({ content: msg })
    }
    return
  }

  const newName = sanitizeChannelName(rawName)

  const [vc, tc] = await Promise.all([
    interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null),
    interaction.guild!.channels.fetch(record.textChannelId).catch(() => null),
  ])

  // The DB keeps the user's typed name undecorated (manual/fallback); the
  // visible name gets a trailing emoji and dodges any collision with another
  // channel — same rule as the auto-named channels.
  const finalName = vc?.isVoiceBased() ? decorateChannelName(vc.guild, newName, vc.id) : newName
  const textName = finalName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice-chat'

  await Promise.all([
    vc?.isVoiceBased() ? vc.setName(finalName).catch(() => {}) : Promise.resolve(),
    tc?.isTextBased() ? (tc as any).setName(textName).catch(() => {}) : Promise.resolve(),
  ])

  await db.update(autoChannels)
    .set({ manualName: newName, autoNameEnabled: false, fallbackName: newName })
    .where(eq(autoChannels.voiceChannelId, voiceChannelId))

  const updated = { ...record, manualName: newName, autoNameEnabled: false, fallbackName: newName }
  await postOrUpdateControlPanel(interaction.client, updated)

  if (interaction.isFromMessage()) {
    await interaction.editReply({ content: `✅ Channel renamed to **${finalName}**.`, components: [] })
  } else {
    await interaction.editReply({ content: `✅ Channel renamed to **${finalName}**.` })
  }
}
