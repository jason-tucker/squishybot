import {
  type ChatInputCommandInteraction,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js'

export const data = new SlashCommandBuilder()
  .setName('report')
  .setDescription('Report a bug or request a feature — files a GitHub issue')

// Anti-throwaway gate (#17): /report is locked for Discord accounts younger
// than this many months — common spam-prevention move.
const MIN_ACCOUNT_AGE_MONTHS = 6

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // Reject brand-new Discord accounts. Compute the unlock date as
  // createdAt + N months and surface it as a relative timestamp so the
  // user knows exactly when they'll be eligible.
  const createdAt = interaction.user.createdAt
  const unlock = new Date(createdAt)
  unlock.setUTCMonth(unlock.getUTCMonth() + MIN_ACCOUNT_AGE_MONTHS)
  if (unlock.getTime() > Date.now()) {
    await interaction.reply({
      content:
        `❌ Your Discord account is too new to file reports. ` +
        `/report unlocks for accounts older than ${MIN_ACCOUNT_AGE_MONTHS} months — yours unlocks <t:${Math.floor(unlock.getTime() / 1000)}:R>.`,
      ephemeral: true,
    })
    return
  }

  const modal = new ModalBuilder()
    .setCustomId('report:submit')
    .setTitle('Report Bug / Feature Request')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('title')
          .setLabel('Title')
          .setStyle(TextInputStyle.Short)
          .setMinLength(5)
          .setMaxLength(200)
          .setRequired(true)
          .setPlaceholder('Short summary of the issue or request')
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('type')
          .setLabel('Type')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(20)
          .setRequired(true)
          .setPlaceholder('bug, feature, or question')
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Description')
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(10)
          .setMaxLength(2000)
          .setRequired(true)
          .setPlaceholder('What happened? What did you expect?')
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('steps')
          .setLabel('Steps to reproduce (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(false)
      ),
    )

  await interaction.showModal(modal)
}
