import type { Client } from 'discord.js'
import { startHealthPush } from '../healthPush'
import { runReconciler } from '../../services/voice/reconciler'
import { logger, attachClientToLogger } from '../../services/logger'
import { initPresence } from '../../services/presence'
import { env } from '../../config/env'
import { loadSettings } from '../../services/settings'
import { loadGames } from '../../services/games'
import { loadSocialFeeds } from '../../services/socialFeeds'
import { startSocialPoller } from '../../services/social/poller'
import { startBirthdayScheduler } from '../../services/birthdayScheduler'

export function registerReadyEvent(client: Client) {
  client.once('clientReady', async (c) => {
    attachClientToLogger(c)
    initPresence(c)
    logger.info(`Logged in as ${c.user.tag}`)
    startHealthPush()
    // Load runtime settings + sudo-user overrides + game catalog + social feeds into caches.
    await Promise.all([
      loadSettings().catch(err => logger.error('Failed to load settings on startup', err)),
      loadGames().catch(err => logger.error('Failed to load games on startup', err)),
      loadSocialFeeds().catch(err => logger.error('Failed to load social feeds on startup', err)),
    ])
    startBirthdayScheduler(c)
    startSocialPoller(c)

    const guild = c.guilds.cache.get(env.GUILD_ID)
    const guildName = guild?.name ?? '(not a member)'
    const otherGuilds = c.guilds.cache.filter(g => g.id !== env.GUILD_ID).map(g => `${g.name} (${g.id})`)

    let result
    try {
      result = await runReconciler(c)
    } catch (err) {
      await logger.errorAndDm('Reconciler failed on startup', err, c)
    }

    const startupMsg =
      `🟢 **SquishyBot started**\n` +
      `Logged in as **${c.user.tag}**\n` +
      `Primary guild (\`GUILD_ID\`): **${guildName}** (\`${env.GUILD_ID}\`)\n` +
      (otherGuilds.length > 0 ? `Also in: ${otherGuilds.join(', ')}\n` : '') +
      (result
        ? `Reconciler: recovered=${result.recovered} cleaned=${result.cleaned} hubs=${result.hubs} panels=${result.panels}`
        : '')

    // Silent — successful boot is informational, not a notification.
    await logger.dmOwner(startupMsg, c, { silent: true })
  })
}
