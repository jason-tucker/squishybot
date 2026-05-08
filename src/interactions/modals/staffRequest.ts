import {
  type ModalSubmitInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ThreadChannel,
} from 'discord.js'
import { db } from '../../db/client'
import { staffApprovals } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../../config/env'
import { logger } from '../../services/logger'
import { sep } from '../../utils/cv2'
import { findStaffRoleDefBySlug } from '../../services/staffRoles'

export async function handleStaffRequestModal(interaction: ModalSubmitInteraction): Promise<void> {
  // customId: staff:request:{slug}
  if (!interaction.customId.startsWith('staff:request:')) return
  const slug = interaction.customId.slice('staff:request:'.length)
  const roleDef = findStaffRoleDefBySlug(slug)
  if (!roleDef) {
    await interaction.reply({ content: `❌ Unknown staff role: \`${slug}\``, ephemeral: true })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  if (!env.STAFF_APPROVAL_THREAD_ID) {
    await interaction.editReply({
      content: '❌ Staff approval thread is not configured. Ask an admin to set `STAFF_APPROVAL_THREAD_ID` in the bot config.',
    })
    return
  }

  const data = {
    role_key: roleDef.key,
    role_label: roleDef.label,
    real_name: interaction.fields.getTextInputValue('real_name') || null,
    reason: interaction.fields.getTextInputValue('reason') || null,
  }

  const [row] = await db.insert(staffApprovals).values({
    guildId: env.GUILD_ID,
    userId: interaction.user.id,
    requestedData: data,
  }).returning()

  // Build the approval card. role_key is internal — show role_label instead.
  const detailLines: string[] = [`**Role:** ${data.role_label}`]
  if (data.real_name) detailLines.push(`**Real / preferred name:** ${data.real_name}`)
  if (data.reason)    detailLines.push(`**Reason:** ${data.reason}`)

  const container = new ContainerBuilder()
    .setAccentColor(0xfee75c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 📥 Staff Request from <@${interaction.user.id}>`)
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(detailLines.join('\n'))
    )

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
    const thread = await interaction.client.channels.fetch(env.STAFF_APPROVAL_THREAD_ID) as ThreadChannel | null
    if (!thread || !thread.isThread()) {
      throw new Error('STAFF_APPROVAL_THREAD_ID does not point to a thread')
    }

    const pingContent = env.STAFF_APPROVAL_PING_USER_ID
      ? `<@${env.STAFF_APPROVAL_PING_USER_ID}> new staff request — **${data.role_label}**`
      : `New staff request — **${data.role_label}**`

    // Components V2 doesn't allow content; send the ping as a separate message.
    await thread.send({
      content: pingContent,
      allowedMentions: { users: env.STAFF_APPROVAL_PING_USER_ID ? [env.STAFF_APPROVAL_PING_USER_ID] : [] },
    })

    const msg = await thread.send({
      flags: MessageFlags.IsComponentsV2,
      components: [container, buttons],
    })

    await db.update(staffApprovals)
      .set({ approvalMsgId: msg.id })
      .where(eq(staffApprovals.id, row.id))

    await interaction.editReply({
      content: `✅ Your request for **${data.role_label}** has been submitted. An admin will review it shortly.`,
    })
    logger.info(`Staff request submitted by ${interaction.user.tag} (id=${row.id}, role=${roleDef.key})`)
  } catch (err) {
    logger.error('Failed to post staff request:', err)
    await interaction.editReply({
      content: '⚠️ Your request was saved, but I could not post it to the approval thread. An admin will need to check.',
    })
  }
}
