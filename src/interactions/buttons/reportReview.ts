import type { ButtonInteraction } from 'discord.js'
import { env } from '../../config/env'
import { logger } from '../../services/logger'
import { getReportSession, deleteReportSession } from '../../services/reportCache'

export async function handleReportReview(interaction: ButtonInteraction): Promise<void> {
  if (interaction.user.id !== env.BOT_OWNER_ID) {
    await interaction.reply({ content: '❌ Only the bot owner can review reports.', ephemeral: true })
    return
  }

  await interaction.deferUpdate()

  const [action, sessionKey] = interaction.customId.split(':')
  const session = getReportSession(sessionKey ?? '')
  if (!session) {
    await interaction.editReply({
      content: '⚠️ Report session expired or already handled.',
      components: [],
    })
    return
  }

  if (action === 'report_reject') {
    deleteReportSession(sessionKey!)
    await interaction.editReply({
      content: `❌ **Rejected** — /report from <@${session.reporterId}> (\`${session.reporterTag}\`)\n**Title:** ${session.title}`,
      components: [],
    })
    try {
      const reporter = await interaction.client.users.fetch(session.reporterId)
      await reporter.send(`Your /report — **${session.title}** — was reviewed and not filed.`)
    } catch {}
    return
  }

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
  deleteReportSession(sessionKey!)

  await interaction.editReply({
    content: `✅ **Filed** Issue **#${data.number}** — ${data.html_url}\nReporter: <@${session.reporterId}> (\`${session.reporterTag}\`)`,
    components: [],
  })

  try {
    const reporter = await interaction.client.users.fetch(session.reporterId)
    await reporter.send(`✅ Your /report has been filed: **#${data.number}** — ${data.html_url}`)
  } catch {}
}
