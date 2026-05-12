/**
 * Staff role request submission — shared between the slash bot flow
 * (`/settings → Staff Role`) and the panel's self-service editor at
 * `/me/edit`. Both paths produce identical Discord output by routing
 * through this one helper.
 *
 * A request can name AT MOST one department and AT MOST one tier; both
 * are optional individually but at least one must be present (we don't
 * accept empty requests — the ITSRI Staff base role is granted on
 * approval regardless, so an empty request would just be "make me
 * staff" which the approver can do via /sudo direct grant instead).
 */
import {
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type Client,
  type ThreadChannel,
} from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { staffApprovals } from '../db/schema'
import { env } from '../config/env'
import { logger } from './logger'
import { sep } from '../utils/cv2'
import { findDepartmentBySlug, findTierBySlug } from './staffRoles'

export type StaffRequestInput = {
  client: Client
  userId: string
  departmentSlug?: string | null
  tierSlug?: string | null
  realName?: string | null
}

export type StaffRequestErrorCode =
  | 'no-selection'
  | 'unknown-department'
  | 'unknown-tier'
  | 'thread-unset'
  | 'thread-not-thread'
  | 'send-failed'

export type StaffRequestResult =
  | {
      ok: true
      approvalId: string
      approvalMsgId: string | null
      departmentLabel: string | null
      tierLabel: string | null
    }
  | { ok: false; error: StaffRequestErrorCode; details?: string }

export async function submitStaffRequest(input: StaffRequestInput): Promise<StaffRequestResult> {
  const { client, userId } = input

  // Normalize — empty strings collapse to null so we don't carry junk
  // through to the JSON blob.
  const deptSlug = input.departmentSlug && input.departmentSlug.length > 0 ? input.departmentSlug : null
  const tierSlug = input.tierSlug && input.tierSlug.length > 0 ? input.tierSlug : null

  if (!deptSlug && !tierSlug) return { ok: false, error: 'no-selection' }

  const deptDef = deptSlug ? findDepartmentBySlug(deptSlug) : null
  if (deptSlug && !deptDef) return { ok: false, error: 'unknown-department' }

  const tierDef = tierSlug ? findTierBySlug(tierSlug) : null
  if (tierSlug && !tierDef) return { ok: false, error: 'unknown-tier' }

  if (!env.STAFF_APPROVAL_THREAD_ID) return { ok: false, error: 'thread-unset' }

  const realName = input.realName?.trim() ? input.realName.trim() : null

  const data = {
    department_key: deptDef?.key ?? null,
    department_label: deptDef?.label ?? null,
    tier_key: tierDef?.key ?? null,
    tier_label: tierDef?.label ?? null,
    real_name: realName,
  }

  const [row] = await db
    .insert(staffApprovals)
    .values({
      guildId: env.GUILD_ID,
      userId,
      requestedData: data,
    })
    .returning()

  const detailLines: string[] = []
  if (deptDef) detailLines.push(`**Department:** ${deptDef.label}`)
  if (tierDef) detailLines.push(`**Tier:** ${tierDef.label}`)
  if (realName) detailLines.push(`**Real / preferred name:** ${realName}`)
  detailLines.push('', '_Approving also grants the **ITSRI Staff** base role._')

  const container = new ContainerBuilder()
    .setAccentColor(0xfee75c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 📥 Staff Request from <@${userId}>`),
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(detailLines.join('\n')))

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`staff:approve:${row.id}`)
      .setLabel('Approve')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`staff:deny:${row.id}`)
      .setLabel('Deny')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  )

  try {
    const thread = (await client.channels.fetch(env.STAFF_APPROVAL_THREAD_ID)) as ThreadChannel | null
    if (!thread || !thread.isThread()) {
      return { ok: false, error: 'thread-not-thread' }
    }

    const pingLabel =
      deptDef && tierDef
        ? `${deptDef.label} · ${tierDef.label}`
        : (deptDef?.label ?? tierDef?.label ?? 'staff')

    const pingContent = env.STAFF_APPROVAL_PING_USER_ID
      ? `<@${env.STAFF_APPROVAL_PING_USER_ID}> new staff request — **${pingLabel}**`
      : `New staff request — **${pingLabel}**`

    await thread.send({
      content: pingContent,
      allowedMentions: { users: env.STAFF_APPROVAL_PING_USER_ID ? [env.STAFF_APPROVAL_PING_USER_ID] : [] },
    })

    const msg = await thread.send({
      flags: MessageFlags.IsComponentsV2,
      components: [container, buttons],
    })

    await db
      .update(staffApprovals)
      .set({ approvalMsgId: msg.id })
      .where(eq(staffApprovals.id, row.id))

    logger.info(
      `Staff request submitted (id=${row.id}, dept=${deptDef?.key ?? '-'}, tier=${tierDef?.key ?? '-'}, user=${userId})`,
    )
    return {
      ok: true,
      approvalId: row.id,
      approvalMsgId: msg.id,
      departmentLabel: deptDef?.label ?? null,
      tierLabel: tierDef?.label ?? null,
    }
  } catch (err) {
    logger.error('Failed to post staff request card', err)
    return {
      ok: false,
      error: 'send-failed',
      details: err instanceof Error ? err.message : String(err),
    }
  }
}
