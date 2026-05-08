import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js'
import { renderPrefsEditor } from '../interactions/gamesEditor'
import { isSudo } from '../services/voice/permissions'

export const data = new SlashCommandBuilder()
  .setName('games')
  .setDescription('Pick which games you want View access and LFG pings for')
  .setDMPermission(false)

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const payload = await renderPrefsEditor(interaction.guild!, interaction.user.id, 'self', isSudo(member))
  await interaction.editReply({ ...payload, flags: MessageFlags.IsComponentsV2 } as any)
}
