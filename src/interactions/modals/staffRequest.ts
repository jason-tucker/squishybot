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

export async function handleStaffRequestModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.customId !== 'staff:request') return

  await interaction.deferReply({ ephemeral: true })

  if (!env.STAFF_APPROVAL_THREAD_ID) {
    await interaction.editReply({
      content: '❌ Staff approval thread is not configured. Ask an admin to set `STAFF_APPROVAL_THREAD_ID` in the bot config.',
    })
    return
  }

  const data = {
    category: interaction.fields.getTextInputValue('category'),
    department: interaction.fields.getTextInputValue('department') || null,
    tier: interaction.fields.getTextInputValue('tier') || null,
    real_name: interaction.fields.getTextInputValue('real_name') || null,
    reason: interaction.fields.getTextInputValue('reason') || null,
  }

  // Insert pending approval row
  const [row] = await db.insert(staffApprovals).values({
    guildId: env.GUILD_ID,
    userId: interaction.user.id,
    requestedData: data,
  }).returning()

  // Build the approval message
  const fields = Object.entries(data)
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => `**${formatLabel(k)}:** ${v}`)
    .join('\n')

  const container = new ContainerBuilder()
    .setAccentColor(0xfee75c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 📥 Staff Request from <@${interaction.user.id}>`)
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(fields || '_No details provided._')
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

  // Post to the approval thread, pinging the reviewer
  try {
    const thread = await interaction.client.channels.fetch(env.STAFF_APPROVAL_THREAD_ID) as ThreadChannel | null
    if (!thread || !thread.isThread()) {
      throw new Error('STAFF_APPROVAL_THREAD_ID does not point to a thread')
    }

    const pingContent = env.STAFF_APPROVAL_PING_USER_ID
      ? `<@${env.STAFF_APPROVAL_PING_USER_ID}> new staff request`
      : 'New staff request'

    // Components V2 doesn't allow content; send the ping as a separate message
    await thread.send({ content: pingContent, allowedMentions: { users: env.STAFF_APPROVAL_PING_USER_ID ? [env.STAFF_APPROVAL_PING_USER_ID] : [] } })

    const msg = await thread.send({
      flags: MessageFlags.IsComponentsV2,
      components: [container, buttons],
    })

    await db.update(staffApprovals)
      .set({ approvalMsgId: msg.id })
      .where(eq(staffApprovals.id, row.id))

    await interaction.editReply({
      content: '✅ Your staff request has been submitted. An admin will review it shortly.',
    })
    logger.info(`Staff request submitted by ${interaction.user.tag} (id=${row.id})`)
  } catch (err) {
    logger.error('Failed to post staff request:', err)
    await interaction.editReply({
      content: '⚠️ Your request was saved, but I could not post it to the approval thread. An admin will need to check.',
    })
  }
}

function formatLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
