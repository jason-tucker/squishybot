import {
  type ModalSubmitInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js'
import { env } from '../../config/env'
import { logger } from '../../services/logger'
import { createReportSession } from '../../services/reportCache'
import { publish, reportCh, type ReportCreatedEvent } from '../../services/eventBus'

export async function handleReportSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    await interaction.editReply({
      content: '❌ /report is not configured. Set `GITHUB_TOKEN` and `GITHUB_REPO` in the bot env.',
    })
    return
  }
  if (!env.BOT_OWNER_ID) {
    await interaction.editReply({
      content: '❌ /report requires `BOT_OWNER_ID` to gate review approval.',
    })
    return
  }

  const title = interaction.fields.getTextInputValue('title')
  const type = interaction.fields.getTextInputValue('type').toLowerCase().trim()
  const description = interaction.fields.getTextInputValue('description')
  const steps = interaction.fields.getTextInputValue('steps')

  const labels: string[] = []
  if (type.startsWith('bug')) labels.push('bug')
  else if (type.startsWith('feat')) labels.push('enhancement')
  else if (type.startsWith('quest')) labels.push('question')

  const body = [
    description,
    steps ? `\n\n## Steps to reproduce\n${steps}` : '',
    `\n\n---\n_Reported by Discord user **${interaction.user.tag}** (\`${interaction.user.id}\`) via /report._`,
  ].join('')

  const sessionKey = createReportSession({
    reporterId: interaction.user.id,
    reporterTag: interaction.user.tag,
    title,
    body,
    labels,
  })

  // #24 — Persist the report to the audit log so /sudo triage can find it.
  // The review handler will look up the most-recent pending row for this user
  // by sessionKey-derived heuristics; for simplicity, the row stores the
  // reporter's user_id and title, and the review handler matches on that.
  let reportRowId: number | null = null
  try {
    const { db } = await import('../../db/client')
    const { reportLog } = await import('../../db/schema')
    const [row] = await db.insert(reportLog).values({
      guildId: interaction.guildId!,
      userId: interaction.user.id,
      title,
      reportType: type || 'unknown',
      description,
      steps: steps || null,
      status: 'pending',
    }).returning({ id: reportLog.id })
    reportRowId = row?.id ?? null
  } catch (err) {
    logger.warn('report_log insert failed', err)
  }

  if (reportRowId !== null) {
    void publish<ReportCreatedEvent>(reportCh('created'), {
      id: reportRowId, status: 'pending', ts: new Date().toISOString(),
    })
  }

  // DM the bot owner with Approve / Reject buttons
  try {
    const owner = await interaction.client.users.fetch(env.BOT_OWNER_ID)

    const labelLine = labels.length > 0 ? labels.join(', ') : '_none_'
    const summary = [
      `📝 **New /report from ${interaction.user.tag}**`,
      `**Title:** ${title}`,
      `**Labels:** ${labelLine}`,
      '',
      body,
    ].join('\n')
    const truncated = summary.length > 1900 ? summary.slice(0, 1900) + '\n_…(truncated)_' : summary

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`report_approve_notice:${sessionKey}`)
        .setLabel('Approve + Notify')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`report_approve_silent:${sessionKey}`)
        .setLabel('Approve, Silent')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`report_reject_notice:${sessionKey}`)
        .setLabel('Reject + Notify')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`report_reject_silent:${sessionKey}`)
        .setLabel('Reject, Silent')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Secondary),
    )

    await owner.send({ content: truncated, components: [row] })
  } catch (err) {
    logger.error('Failed to DM bot owner about /report:', err)
    await interaction.editReply({
      content: '❌ Could not notify the bot owner. The owner may have DMs disabled. Try again later.',
    })
    return
  }

  await interaction.editReply({
    content: '✅ Your report has been sent to the bot owner for review. You\'ll get a DM with the result.',
  })
}
