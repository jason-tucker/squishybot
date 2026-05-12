import type { ModalSubmitInteraction } from 'discord.js'
import { submitStaffRequest } from '../../services/staffRequestService'

export async function handleStaffRequestModal(interaction: ModalSubmitInteraction): Promise<void> {
  // customId formats accepted:
  //   - staff:request:{dept_or_none}:{tier_or_none}  (current — two axes)
  //   - staff:request:{single_slug}                  (legacy — one role)
  if (!interaction.customId.startsWith('staff:request:')) return

  const tail = interaction.customId.slice('staff:request:'.length)
  const parts = tail.split(':')

  let departmentSlug: string | null
  let tierSlug: string | null

  if (parts.length === 2) {
    // New format: {dept}:{tier}, with 'none' meaning "not picked".
    departmentSlug = parts[0] === 'none' ? null : parts[0]
    tierSlug = parts[1] === 'none' ? null : parts[1]
  } else {
    // Legacy single-slug modal. Map old tier_*/department slugs onto the
    // new two-axis shape so an in-flight modal from an older client
    // doesn't 400. The submission service still validates the slug.
    const legacy = parts[0]
    const isTier = /^tier_\d+$/.test(legacy)
    departmentSlug = isTier ? null : legacy
    tierSlug = isTier ? legacy : null
  }

  await interaction.deferReply({ ephemeral: true })

  const realNameInput = interaction.fields.getTextInputValue('real_name')

  const result = await submitStaffRequest({
    client: interaction.client,
    userId: interaction.user.id,
    departmentSlug,
    tierSlug,
    realName: realNameInput,
  })

  if (!result.ok) {
    const msg =
      result.error === 'no-selection'
        ? '❌ Pick a department or a tier (or both) before submitting.'
        : result.error === 'unknown-department'
          ? `❌ Unknown department: \`${departmentSlug}\``
          : result.error === 'unknown-tier'
            ? `❌ Unknown tier: \`${tierSlug}\``
            : result.error === 'thread-unset'
              ? '❌ Staff approval thread is not configured. Ask an admin to set `STAFF_APPROVAL_THREAD_ID`.'
              : result.error === 'thread-not-thread'
                ? '❌ `STAFF_APPROVAL_THREAD_ID` does not point to a thread.'
                : '⚠️ Your request was saved, but I could not post it to the approval thread. An admin will need to check.'
    await interaction.editReply({ content: msg })
    return
  }

  const what =
    result.departmentLabel && result.tierLabel
      ? `${result.departmentLabel} · ${result.tierLabel}`
      : (result.departmentLabel ?? result.tierLabel ?? 'staff role')

  await interaction.editReply({
    content: `✅ Your request for **${what}** has been submitted. An admin will review it shortly. (Approving will also grant the **ITSRI Staff** base role.)`,
  })
}
