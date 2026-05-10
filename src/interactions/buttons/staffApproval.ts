import {
  type ButtonInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} from 'discord.js'
import { db } from '../../db/client'
import { staffApprovals } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { isSudo } from '../../services/voice/permissions'
import { logger } from '../../services/logger'
import { sep } from '../../utils/cv2'
import { getSetting } from '../../services/settings'
import { findStaffRoleDefByKey } from '../../services/staffRoles'

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

  // On approval, try to grant the linked role. Errors are surfaced into the
  // approval card so the reviewer sees what happened (and the requester gets a
  // matching DM).
  let grantNote: string | null = null
  if (newStatus === 'approved') {
    grantNote = await tryGrantRole(interaction, row.userId, data)
  }

  // --- Render the approval card -------------------------------------------
  const detailLines: string[] = []
  const roleLabel = typeof data.role_label === 'string' ? data.role_label : null
  const roleKey   = typeof data.role_key   === 'string' ? data.role_key   : null
  if (roleLabel) detailLines.push(`**Role:** ${roleLabel}`)
  if (typeof data.real_name === 'string' && data.real_name) detailLines.push(`**Real / preferred name:** ${data.real_name}`)
  if (typeof data.reason === 'string' && data.reason)       detailLines.push(`**Reason:** ${data.reason}`)
  // Legacy rows (pre-redesign) lack role_label — fall back to dumping every
  // remaining field so the reviewer still sees what was originally requested.
  // Coerce to string + cap length so a malformed JSON shape (object/array
  // value, megabyte-long string) can't destabilize the approval card render
  // or hit Discord's 4000-char text-display limit.
  if (!roleLabel) {
    for (const [k, v] of Object.entries(data)) {
      if (v === null || v === undefined || v === '') continue
      const display = (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 200)
      detailLines.push(`**${formatLabel(k)}:** ${display}`)
    }
  }
  if (grantNote) detailLines.push('', grantNote)

  const accent = newStatus === 'approved' ? 0x57f287 : 0xed4245
  const heading = newStatus === 'approved' ? '✅ Staff Request Approved' : '❌ Staff Request Denied'

  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${heading}\nRequester: <@${row.userId}>\nReviewed by: <@${member.id}>`)
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(detailLines.join('\n') || '_No details provided._')
    )

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    content: null,
  })

  // DM the requester with the outcome (and the role grant status if applicable).
  try {
    const requester = await interaction.client.users.fetch(row.userId)
    if (newStatus === 'approved') {
      const role = roleLabel ? ` (**${roleLabel}**)` : ''
      const detail = grantNote ? `\n${grantNote}` : ''
      await requester.send(`✅ Your staff request${role} in **${interaction.guild!.name}** has been approved.${detail}`)
    } else {
      await requester.send(
        `❌ Your staff request in **${interaction.guild!.name}** was denied. Reach out to a sudo if you have questions.`
      )
    }
  } catch {
    // user has DMs disabled; ignore
  }

  logger.info(`Staff request ${id} ${newStatus} by ${member.user.tag}${roleKey ? ` (role=${roleKey})` : ''}`)
}

/**
 * Resolve the role from `data.role_key`, fetch the requester as a member, and
 * add the role. Returns a one-line note to embed in the approval card / DM.
 *
 * Returns `null` if the request was a legacy row (no `role_key`) — caller
 * skips the grant entirely in that case.
 */
async function tryGrantRole(
  interaction: ButtonInteraction,
  requesterId: string,
  data: Record<string, unknown>,
): Promise<string | null> {
  const roleKey = typeof data.role_key === 'string' ? data.role_key : null
  if (!roleKey) return '_⚠️ Legacy request — no role was granted automatically. Add the role manually._'

  const def = findStaffRoleDefByKey(roleKey)
  if (!def) return `⚠️ Unknown role key \`${roleKey}\` — nothing granted.`

  const roleId = getSetting(roleKey)
  if (!roleId) {
    return `⚠️ Role **${def.label}** is not linked yet. Run \`/sudo → Settings → Staff Roles → Provision & link\` first, then re-grant manually.`
  }

  const role = interaction.guild!.roles.cache.get(roleId)
    ?? await interaction.guild!.roles.fetch(roleId).catch(() => null)
  if (!role) {
    return `⚠️ Linked role for **${def.label}** (id \`${roleId}\`) no longer exists in Discord.`
  }

  const targetMember = await interaction.guild!.members.fetch(requesterId).catch(() => null)
  if (!targetMember) return `⚠️ Could not fetch <@${requesterId}> — they may have left the server.`

  if (targetMember.roles.cache.has(role.id)) {
    return `ℹ️ <@${requesterId}> already had **${def.label}**.`
  }

  try {
    await targetMember.roles.add(role, `staff request approved by ${interaction.user.tag}`)
    logger.info(`Granted ${def.label} (${role.id}) to ${targetMember.user.tag} via staff request`)
    return `🎖️ Granted **${def.label}** to <@${requesterId}>.`
  } catch (err) {
    logger.warn(`Failed to grant ${def.label} to ${requesterId}:`, err)
    return `⚠️ Failed to grant **${def.label}**: ${(err as Error).message}`
  }
}

function formatLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
