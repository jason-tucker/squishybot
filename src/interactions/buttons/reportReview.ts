import type { ButtonInteraction } from 'discord.js'
import { env } from '../../config/env'
import { isBotOwner } from '../../services/botOwner'
import { logger } from '../../services/logger'
import { getReportSession, deleteReportSession } from '../../services/reportCache'
import { db } from '../../db/client'
import { reportLog } from '../../db/schema'
import { and, desc, eq } from 'drizzle-orm'

async function markReportLogStatus(
  userId: string,
  title: string,
  status: 'filed' | 'dropped',
  githubIssueUrl: string | null,
  decidedByUserId: string,
): Promise<void> {
  // Match the most-recent pending row by (user, title). Each /report submit
  // inserts exactly one row, so the latest pending one is the right target.
  const [latest] = await db.select({ id: reportLog.id }).from(reportLog)
    .where(and(eq(reportLog.userId, userId), eq(reportLog.title, title), eq(reportLog.status, 'pending')))
    .orderBy(desc(reportLog.createdAt))
    .limit(1)
  if (!latest) return
  await db.update(reportLog)
    .set({ status, githubIssueUrl, decidedByUserId, decidedAt: new Date() })
    .where(eq(reportLog.id, latest.id))
    .catch(() => {})
}

export async function handleReportReview(interaction: ButtonInteraction): Promise<void> {
  if (!await isBotOwner(interaction.client, interaction.user.id)) {
    await interaction.reply({ content: '❌ Only a bot owner can review reports.', ephemeral: true })
    return
  }

  await interaction.deferUpdate()

  // customId is one of:
  //   report_approve_notice:{key}, report_approve_silent:{key}
  //   report_reject_notice:{key},  report_reject_silent:{key}
  const colonIdx = interaction.customId.indexOf(':')
  const action = interaction.customId.slice(0, colonIdx)
  const sessionKey = interaction.customId.slice(colonIdx + 1)

  const session = getReportSession(sessionKey)
  if (!session) {
    await interaction.editReply({
      content: '⚠️ Report session expired or already handled.',
      components: [],
    })
    return
  }

  const notify = action.endsWith('_notice')
  const isApprove = action.startsWith('report_approve')

  if (!isApprove) {
    deleteReportSession(sessionKey)
    await markReportLogStatus(session.reporterId, session.title, 'dropped', null, interaction.user.id)
    await interaction.editReply({
      content: `❌ **Rejected${notify ? '' : ' silently'}** — /report from <@${session.reporterId}> (\`${session.reporterTag}\`)\n**Title:** ${session.title}`,
      components: [],
    })
    if (notify) {
      try {
        const reporter = await interaction.client.users.fetch(session.reporterId)
        await reporter.send(`Your /report — **${session.title}** — was reviewed and not filed.`)
      } catch {}
    }
    return
  }

  // Approve path
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    await interaction.editReply({
      content: '❌ Cannot file: `GITHUB_TOKEN` / `GITHUB_REPO` not set on the bot.',
      components: [],
    })
    return
  }

  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'squishybot-report',
    },
    body: JSON.stringify({ title: session.title, body: session.body, labels: session.labels }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '<no body>')
    logger.error(`/report approve: GitHub API ${res.status}: ${errText}`)
    await interaction.editReply({
      content: `❌ Failed to file issue (HTTP ${res.status}). Session preserved — try again or reject.`,
    })
    return
  }

  const data = (await res.json()) as { html_url: string; number: number }
  deleteReportSession(sessionKey)
  await markReportLogStatus(session.reporterId, session.title, 'filed', data.html_url, interaction.user.id)

  await interaction.editReply({
    content: `✅ **Filed${notify ? ' + notified reporter' : ' silently'}** — Issue **#${data.number}** — ${data.html_url}\nReporter: <@${session.reporterId}> (\`${session.reporterTag}\`)`,
    components: [],
  })

  if (notify) {
    try {
      const reporter = await interaction.client.users.fetch(session.reporterId)
      await reporter.send(`✅ Your /report has been filed: **#${data.number}** — ${data.html_url}`)
    } catch {}
  }
}
