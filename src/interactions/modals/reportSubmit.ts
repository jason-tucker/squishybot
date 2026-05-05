import type { ModalSubmitInteraction } from 'discord.js'
import { env } from '../../config/env'
import { logger } from '../../services/logger'

export async function handleReportSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    await interaction.editReply({
      content: '❌ /report is not configured. Set `GITHUB_TOKEN` and `GITHUB_REPO` in the bot env.',
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

  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'squishybot-report',
    },
    body: JSON.stringify({ title, body, labels }),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '<no body>')
    logger.error(`/report: GitHub API ${res.status}: ${err}`)
    await interaction.editReply({
      content: `❌ Failed to file issue (HTTP ${res.status}). Check bot logs.`,
    })
    return
  }

  const data = (await res.json()) as { html_url: string; number: number }
  await interaction.editReply({
    content: `✅ Issue **#${data.number}** filed: ${data.html_url}`,
  })
}
