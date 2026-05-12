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
import { BASE_DEFS, findStaffRoleDefByKey, type StaffRoleDef } from '../../services/staffRoles'

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

  // Resolve the requested role keys from the JSON blob. Supports BOTH
  // shapes:
  //   - NEW: { department_key?, tier_key?, real_name? }
  //   - LEGACY: { role_key, role_label, ... } (single role per request).
  // Legacy rows skip the ITSRI Staff base grant (that's a new addition
  // — the original flow didn't promise it). New rows always include it.
  const departmentKey = typeof data.department_key === 'string' ? data.department_key : null
  const tierKey = typeof data.tier_key === 'string' ? data.tier_key : null
  const legacyRoleKey = typeof data.role_key === 'string' ? data.role_key : null

  const isLegacy = !departmentKey && !tierKey && legacyRoleKey !== null

  let grantNote: string | null = null
  if (newStatus === 'approved') {
    grantNote = await tryGrantRoles(interaction, row.userId, {
      isLegacy,
      keys: isLegacy
        ? [legacyRoleKey!]
        : [
            ...(departmentKey ? [departmentKey] : []),
            ...(tierKey ? [tierKey] : []),
            ...BASE_DEFS.map((d) => d.key),
          ],
    })
  }

  // --- Render the approval card -------------------------------------------
  const detailLines: string[] = []
  const departmentLabel = typeof data.department_label === 'string' ? data.department_label : null
  const tierLabel = typeof data.tier_label === 'string' ? data.tier_label : null
  if (departmentLabel) detailLines.push(`**Department:** ${departmentLabel}`)
  if (tierLabel) detailLines.push(`**Tier:** ${tierLabel}`)

  // Legacy fields — only used when neither department nor tier was set on
  // the new shape (i.e. the row predates the redesign).
  const legacyRoleLabel = typeof data.role_label === 'string' ? data.role_label : null
  if (!departmentLabel && !tierLabel && legacyRoleLabel) {
    detailLines.push(`**Role:** ${legacyRoleLabel}`)
  }

  if (typeof data.real_name === 'string' && data.real_name) {
    detailLines.push(`**Real / preferred name:** ${data.real_name}`)
  }

  // Legacy `reason` rendering (if a row still has one).
  if (typeof data.reason === 'string' && data.reason) {
    detailLines.push(`**Reason:** ${data.reason}`)
  }

  // Final fallback: dump every remaining string field if nothing rendered.
  if (detailLines.length === 0) {
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
      new TextDisplayBuilder().setContent(`## ${heading}\nRequester: <@${row.userId}>\nReviewed by: <@${member.id}>`),
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(detailLines.join('\n') || '_No details provided._'),
    )

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    content: null,
  })

  // DM the requester with the outcome.
  try {
    const requester = await interaction.client.users.fetch(row.userId)
    if (newStatus === 'approved') {
      const what =
        departmentLabel && tierLabel
          ? ` (**${departmentLabel} · ${tierLabel}**)`
          : departmentLabel
            ? ` (**${departmentLabel}**)`
            : tierLabel
              ? ` (**${tierLabel}**)`
              : legacyRoleLabel
                ? ` (**${legacyRoleLabel}**)`
                : ''
      const detail = grantNote ? `\n${grantNote}` : ''
      await requester.send(
        `✅ Your staff request${what} in **${interaction.guild!.name}** has been approved.${detail}`,
      )
    } else {
      await requester.send(
        `❌ Your staff request in **${interaction.guild!.name}** was denied. Reach out to a sudo if you have questions.`,
      )
    }
  } catch {
    // user has DMs disabled; ignore
  }

  logger.info(
    `Staff request ${id} ${newStatus} by ${member.user.tag}` +
      (isLegacy
        ? ` (legacy role=${legacyRoleKey})`
        : ` (dept=${departmentKey ?? '-'}, tier=${tierKey ?? '-'})`),
  )
}

/**
 * Grant a list of staff role keys to the requester. Returns a multi-line
 * note describing the outcome of EACH grant (success / already-had /
 * unlinked / missing / Discord error) so the approval card surfaces the
 * full picture even when one role in the bundle fails.
 */
async function tryGrantRoles(
  interaction: ButtonInteraction,
  requesterId: string,
  opts: { isLegacy: boolean; keys: string[] },
): Promise<string> {
  if (opts.keys.length === 0) {
    return '_⚠️ No roles to grant — request was empty._'
  }

  const targetMember = await interaction.guild!.members.fetch(requesterId).catch(() => null)
  if (!targetMember) {
    return `⚠️ Could not fetch <@${requesterId}> — they may have left the server.`
  }

  const lines: string[] = []
  for (const key of opts.keys) {
    const def = findStaffRoleDefByKey(key)
    if (!def) {
      lines.push(`⚠️ Unknown role key \`${key}\` — skipped.`)
      continue
    }

    const roleId = getSetting(key)
    if (!roleId) {
      lines.push(
        `⚠️ **${def.label}** is not linked yet. Run \`/sudo → Settings → Staff Roles → Provision & link\` first, then re-grant manually.`,
      )
      continue
    }

    const role =
      interaction.guild!.roles.cache.get(roleId) ??
      (await interaction.guild!.roles.fetch(roleId).catch(() => null))
    if (!role) {
      lines.push(`⚠️ Linked role for **${def.label}** (id \`${roleId}\`) no longer exists in Discord.`)
      continue
    }

    if (targetMember.roles.cache.has(role.id)) {
      lines.push(`ℹ️ Already had **${def.label}**.`)
      continue
    }

    try {
      await targetMember.roles.add(role, `staff request approved by ${interaction.user.tag}`)
      logger.info(`Granted ${def.label} (${role.id}) to ${targetMember.user.tag} via staff request`)
      lines.push(`🎖️ Granted **${def.label}**.`)
    } catch (err) {
      logger.warn(`Failed to grant ${def.label} to ${requesterId}:`, err)
      lines.push(`⚠️ Failed to grant **${def.label}**: ${(err as Error).message}`)
    }
  }

  if (opts.isLegacy) {
    lines.push(
      '_(Legacy request — ITSRI Staff base role was NOT auto-granted; new requests get it.)_',
    )
  }

  return lines.join('\n')
}

function formatLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Re-export so unused-import warnings stay quiet in build (type used in
// fall-back rendering of legacy data shapes).
export type { StaffRoleDef }
