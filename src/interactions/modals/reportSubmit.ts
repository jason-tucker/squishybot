import { type ModalSubmitInteraction } from 'discord.js'
import { submitReport } from '../../services/reportRequestService'

export async function handleReportSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const title = interaction.fields.getTextInputValue('title')
  const type = interaction.fields.getTextInputValue('type')
  const description = interaction.fields.getTextInputValue('description')
  const steps = interaction.fields.getTextInputValue('steps')

  const result = await submitReport({
    client: interaction.client,
    userId: interaction.user.id,
    userTag: interaction.user.tag,
    title,
    type,
    description,
    steps,
    guildId: interaction.guildId ?? undefined,
  })

  if (!result.ok) {
    let message: string
    switch (result.error) {
      case 'not-configured':
        message = '❌ /report is not configured. Set `GITHUB_TOKEN` and `GITHUB_REPO` in the bot env.'
        break
      case 'owner-unset':
        message = '❌ /report requires `BOT_OWNER_ID` to gate review approval.'
        break
      case 'missing-fields':
        message = '❌ Title and description are required.'
        break
      case 'owner-dm-failed':
        message = '❌ Could not notify the bot owner. The owner may have DMs disabled. Try again later.'
        break
      default:
        message = '❌ Something went wrong submitting your report.'
    }
    await interaction.editReply({ content: message })
    return
  }

  await interaction.editReply({
    content: '✅ Your report has been sent to the bot owner for review. You\'ll get a DM with the result.',
  })
}
