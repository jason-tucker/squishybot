import {
  type ButtonInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} from 'discord.js'
import { db } from '../../db/client'
import { staffApprovals } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { isSudo } from '../../services/voice/permissions'
import { logger } from '../../services/logger'

export async function handleStaffApprovalButton(interaction: ButtonInteraction): Promise<void> {
  // customId format: staff:approve:{id} or staff:deny:{id}
  const parts = interaction.customId.split(':')
  if (parts.length !== 3 || parts[0] !== 'staff') return

  const action = parts[1] as 'approve' | 'deny'
  const id = parts[2]

  const member = await interaction.guild!.members.fetch(interaction.user.id)
  if (!isSudo(member)) {
    await interaction.reply({ content: '❌ Only sudo users can review staff requests.', ephemeral: true })
    return
  }

  const [row] = await db.select().from(staffApprovals).where(eq(staffApprovals.id, id))
  if (!row) {
    await interaction.reply({ content: '❌ This request no longer exists.', ephemeral: true })
    return
  }
  if (row.status !== 'pending') {
    await interaction.reply({ content: `ℹ️ This request was already ${row.status} by <@${row.reviewedBy}>.`, ephemeral: true })
    return
  }

  await interaction.deferUpdate()

  const newStatus = action === 'approve' ? 'approved' : 'denied'
  await db.update(staffApprovals)
    .set({ status: newStatus, reviewedBy: member.id, reviewedAt: new Date() })
    .where(eq(staffApprovals.id, id))

  const data = row.requestedData as Record<string, unknown>
  const fields = Object.entries(data)
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => `**${formatLabel(k)}:** ${v}`)
    .join('\n')

  const accent = newStatus === 'approved' ? 0x57f287 : 0xed4245
  const heading = newStatus === 'approved' ? '✅ Staff Request Approved' : '❌ Staff Request Denied'

  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${heading}\nRequester: <@${row.userId}>\nReviewed by: <@${member.id}>`)
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(fields || '_No details provided._')
    )

  // Edit the original approval message — buttons removed
  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    content: null,
  })

  // DM the requester
  try {
    const requester = await interaction.client.users.fetch(row.userId)
    await requester.send(
      newStatus === 'approved'
        ? `✅ Your staff request in **${interaction.guild!.name}** has been approved.`
        : `❌ Your staff request in **${interaction.guild!.name}** was denied. Reach out to a sudo if you have questions.`
    )
  } catch {
    // user has DMs disabled; ignore
  }

  logger.info(`Staff request ${id} ${newStatus} by ${member.user.tag}`)
}

function formatLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
