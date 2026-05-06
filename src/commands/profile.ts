import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js'
import { renderProfileEditor } from '../interactions/profileEditor'

export const data = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('Edit your bot profile (display name, birthday, ping opt-outs)')
  .setDMPermission(false)

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const payload = await renderProfileEditor(
    interaction.guildId!,
    interaction.user.id,
    member.displayName,
    'self',
  )
  await interaction.editReply({ ...payload, flags: MessageFlags.IsComponentsV2 } as any)
}
