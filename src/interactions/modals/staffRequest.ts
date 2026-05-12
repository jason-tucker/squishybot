import type { ModalSubmitInteraction } from 'discord.js'
import { submitStaffRequest } from '../../services/staffRequestService'

export async function handleStaffRequestModal(interaction: ModalSubmitInteraction): Promise<void> {
  // customId: staff:request:{slug}
  if (!interaction.customId.startsWith('staff:request:')) return
  const slug = interaction.customId.slice('staff:request:'.length)

  await interaction.deferReply({ ephemeral: true })

  const result = await submitStaffRequest({
    client: interaction.client,
    userId: interaction.user.id,
    slug,
    realName: interaction.fields.getTextInputValue('real_name'),
    reason: interaction.fields.getTextInputValue('reason'),
  })

  if (!result.ok) {
    const msg =
      result.error === 'unknown-role'
        ? `❌ Unknown staff role: \`${slug}\``
        : result.error === 'thread-unset'
          ? '❌ Staff approval thread is not configured. Ask an admin to set `STAFF_APPROVAL_THREAD_ID` in the bot config.'
          : result.error === 'thread-not-thread'
            ? '❌ `STAFF_APPROVAL_THREAD_ID` does not point to a thread.'
            : '⚠️ Your request was saved, but I could not post it to the approval thread. An admin will need to check.'
    await interaction.editReply({ content: msg })
    return
  }

  await interaction.editReply({
    content: `✅ Your request for **${result.roleLabel}** has been submitted. An admin will review it shortly.`,
  })
}
