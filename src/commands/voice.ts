import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js'
import { db } from '../db/client'
import { autoChannels } from '../db/schema'
import { eq } from 'drizzle-orm'
import { canControlChannel, isSudo } from '../services/voice/permissions'
import { buildPanelPayloadForRecord } from '../services/voice/controlPanel'
import { client } from '../bot/client'
import { panelLinkDisplay } from '../utils/panelLink'

export const data = new SlashCommandBuilder()
  .setName('voice')
  .setDescription('Open your voice channel control panel')
  .setDMPermission(false)

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const voiceChannelId = member.voice.channelId

  if (!voiceChannelId) {
    await interaction.editReply({ content: '❌ You need to be in a voice channel to use this.' })
    return
  }

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))

  if (!record) {
    await interaction.editReply({ content: '❌ This isn\'t an auto voice channel. Join a hub channel to create one.' })
    return
  }

  if (!canControlChannel(member, record) && !isSudo(member)) {
    await interaction.editReply({ content: '❌ You need to be the owner or a host of this channel.' })
    return
  }

  // Refresh the persistent panel in the text channel
  const { postOrUpdateControlPanel } = await import('../services/voice/controlPanel')
  await postOrUpdateControlPanel(client, record)

  // Also send an ephemeral panel so they can use controls from anywhere
  const payload = await buildPanelPayloadForRecord(client, record)
  const linkLine = panelLinkDisplay('/squishy/voice', 'Manage voice channels on the website')
  await interaction.editReply({
    ...payload,
    components: [...(payload.components as any[]), linkLine],
    flags: (payload.flags | MessageFlags.Ephemeral),
  } as any)
}
