import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js'
import { renderPrefsEditor } from '../interactions/gamesEditor'

export const data = new SlashCommandBuilder()
  .setName('games')
  .setDescription('Pick which games you want View access and LFG pings for')
  .setDMPermission(false)

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })
  const payload = await renderPrefsEditor(interaction.guild!, interaction.user.id, 'self')
  await interaction.editReply({ ...payload, flags: MessageFlags.IsComponentsV2 } as any)
}
