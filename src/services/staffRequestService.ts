/**
 * Staff role request submission — shared between the slash modal
 * (`/settings → Staff Role`) and the panel's self-service editor at
 * `/me/edit`. Both paths must produce an identical Discord experience:
 * the same approval card layout, the same ping content, the same row
 * shape in `staff_approvals`. Centralizing here keeps that invariant.
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
import { findStaffRoleDefBySlug } from './staffRoles'

export type StaffRequestInput = {
  client: Client
  userId: string
  slug: string
  realName?: string | null
  reason?: string | null
}

export type StaffRequestResult =
  | {
      ok: true
      approvalId: string
      approvalMsgId: string | null
      roleLabel: string
    }
  | { ok: false; error: 'unknown-role' | 'thread-unset' | 'thread-not-thread' | 'send-failed'; details?: string }

export async function submitStaffRequest({
  client,
  userId,
  slug,
  realName,
  reason,
}: StaffRequestInput): Promise<StaffRequestResult> {
  const roleDef = findStaffRoleDefBySlug(slug)
  if (!roleDef) return { ok: false, error: 'unknown-role' }

  if (!env.STAFF_APPROVAL_THREAD_ID) {
    return { ok: false, error: 'thread-unset' }
  }

  const data = {
    role_key: roleDef.key,
    role_label: roleDef.label,
    real_name: realName?.trim() ? realName.trim() : null,
    reason: reason?.trim() ? reason.trim() : null,
  }

  const [row] = await db
    .insert(staffApprovals)
    .values({
      guildId: env.GUILD_ID,
      userId,
      requestedData: data,
    })
    .returning()

  const detailLines: string[] = [`**Role:** ${data.role_label}`]
  if (data.real_name) detailLines.push(`**Real / preferred name:** ${data.real_name}`)
  if (data.reason) detailLines.push(`**Reason:** ${data.reason}`)

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

    const pingContent = env.STAFF_APPROVAL_PING_USER_ID
      ? `<@${env.STAFF_APPROVAL_PING_USER_ID}> new staff request — **${data.role_label}**`
      : `New staff request — **${data.role_label}**`

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

    logger.info(`Staff request submitted (id=${row.id}, role=${roleDef.key}, user=${userId})`)
    return { ok: true, approvalId: row.id, approvalMsgId: msg.id, roleLabel: roleDef.label }
  } catch (err) {
    logger.error('Failed to post staff request card', err)
    // Row is already saved — caller surfaces the partial-success.
    return {
      ok: false,
      error: 'send-failed',
      details: err instanceof Error ? err.message : String(err),
    }
  }
}
