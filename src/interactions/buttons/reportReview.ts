import type { ButtonInteraction } from 'discord.js'
import { env } from '../../config/env'
import { isBotOwner } from '../../services/botOwner'
import { logger } from '../../services/logger'
import {
  releaseReportSession,
  reportSessionState,
  restoreReportSession,
  takeReportSession,
} from '../../services/reportCache'
import { db } from '../../db/client'
import { reportLog } from '../../db/schema'
import { and, desc, eq } from 'drizzle-orm'
import {
  publish,
  reportCh,
  type ReportApprovedEvent,
  type ReportRejectedEvent,
} from '../../services/eventBus'

/**
 * Returns the id of the updated row so the caller can fan it out on Redis
 * with the same id the panel will see in DB lookups.
 */
async function markReportLogStatus(
  userId: string,
  title: string,
  status: 'filed' | 'dropped',
  githubIssueUrl: string | null,
  decidedByUserId: string,
): Promise<string | null> {
  // Match the most-recent pending row by (user, title). Each /report submit
  // inserts exactly one row, so the latest pending one is the right target.
  const [latest] = await db.select({ id: reportLog.id }).from(reportLog)
    .where(and(eq(reportLog.userId, userId), eq(reportLog.title, title), eq(reportLog.status, 'pending')))
    .orderBy(desc(reportLog.createdAt))
    .limit(1)
  if (!latest) return null
  await db.update(reportLog)
    .set({ status, githubIssueUrl, decidedByUserId, decidedAt: new Date() })
    .where(eq(reportLog.id, latest.id))
    .catch(() => {})
  return latest.id
}

const GITHUB_TIMEOUT_MS = 15_000

export async function handleReportReview(interaction: ButtonInteraction): Promise<void> {
  // Defer FIRST — before the bot-owner check. isBotOwner() can do a live
  // app.fetch() when its 60s cache has expired, which can blow the 3s ack
  // window (especially right after a deploy). Denial goes via followUp since
  // we're already acknowledged by then.
  await interaction.deferUpdate()
  if (!await isBotOwner(interaction.client, interaction.user.id)) {
    await interaction.followUp({ content: '❌ Only a bot owner can review reports.', ephemeral: true })
    return
  }

  // customId is one of:
  //   report_approve_notice:{key}, report_approve_silent:{key}
  //   report_reject_notice:{key},  report_reject_silent:{key}
  const colonIdx = interaction.customId.indexOf(':')
  const action = interaction.customId.slice(0, colonIdx)
  const sessionKey = interaction.customId.slice(colonIdx + 1)

  // Take (get + delete) synchronously, before any await, so a double click
  // or a second reviewer cannot act on the same session twice. Every
  // failure path below that keeps the session usable restores it.
  const session = takeReportSession(sessionKey)
  if (!session) {
    const state = reportSessionState(sessionKey)
    if (state === 'in-flight' || state === 'handled') {
      // Another click owns (or owned) this card; leave its content alone.
      await interaction.followUp({
        content: state === 'in-flight'
          ? 'ℹ️ This report is already being handled.'
          : 'ℹ️ This report was already handled.',
        ephemeral: true,
      })
      return
    }
    await interaction.editReply({
      content: '⚠️ Report session expired or already handled.',
      components: [],
    })
    return
  }

  const notify = action.endsWith('_notice')
  const isApprove = action.startsWith('report_approve')

  if (!isApprove) {
    releaseReportSession(sessionKey)
    const droppedId = await markReportLogStatus(session.reporterId, session.title, 'dropped', null, interaction.user.id)
    if (droppedId !== null) {
      void publish<ReportRejectedEvent>(reportCh('rejected'), {
        id: droppedId, status: 'dropped', ts: new Date().toISOString(),
      })
    }
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
    restoreReportSession(sessionKey, session)
    // Keep the buttons: the session is still usable (reject, or retry once set).
    await interaction.editReply({
      content: '❌ Cannot file: `GITHUB_TOKEN` / `GITHUB_REPO` not set on the bot. Session preserved — fix the config and retry, or reject.',
    })
    return
  }

  let data: { html_url: string; number: number }
  let created = false
  try {
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'squishybot-report',
      },
      body: JSON.stringify({ title: session.title, body: session.body, labels: session.labels }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '<no body>')
      logger.error(`/report approve: GitHub API ${res.status}: ${errText}`)
      restoreReportSession(sessionKey, session)
      await interaction.editReply({
        content: `❌ Failed to file issue (HTTP ${res.status}). Session preserved — try again or reject.`,
      })
      return
    }

    created = true
    data = (await res.json()) as { html_url: string; number: number }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    if (created) {
      // GitHub accepted the issue but the response body was unreadable. Do
      // not restore: a retry would file a duplicate.
      logger.error(`/report approve: issue created but response unreadable: ${msg}`)
      releaseReportSession(sessionKey)
      const unreadId = await markReportLogStatus(session.reporterId, session.title, 'filed', null, interaction.user.id)
      if (unreadId !== null) {
        void publish<ReportApprovedEvent>(reportCh('approved'), {
          id: unreadId, status: 'filed', ts: new Date().toISOString(),
        })
      }
      await interaction.editReply({
        content: '⚠️ GitHub accepted the issue but its reply could not be read. Check the repo before filing again.',
        components: [],
      })
      return
    }
    // Network error or timeout. GitHub may still have created the issue if
    // the response was lost; the reviewer sees the error and can check.
    logger.error(`/report approve: GitHub request failed: ${msg}`)
    restoreReportSession(sessionKey, session)
    await interaction.editReply({
      content: '❌ GitHub unreachable or timed out. The issue may still have been filed — check the repo before retrying. Session preserved — retry or reject.',
    })
    return
  }

  releaseReportSession(sessionKey)
  const filedId = await markReportLogStatus(session.reporterId, session.title, 'filed', data.html_url, interaction.user.id)
  if (filedId !== null) {
    void publish<ReportApprovedEvent>(reportCh('approved'), {
      id: filedId, status: 'filed', ts: new Date().toISOString(),
    })
  }

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
