import type { Client } from 'discord.js'
import { startHealthPush } from '../healthPush'
import { runReconciler } from '../../services/voice/reconciler'
import { logger, attachClientToLogger } from '../../services/logger'
import { initPresence, refreshPresence } from '../../services/presence'
import { env } from '../../config/env'
import { loadSettings } from '../../services/settings'
import { loadGames } from '../../services/games'
import { loadSocialFeeds } from '../../services/socialFeeds'
import { startSocialPoller } from '../../services/social/poller'
import { startBirthdayScheduler } from '../../services/birthdayScheduler'
import { logResolvedBotOwners } from '../../services/botOwner'
import { getBoolSetting } from '../../services/settings'

export function registerReadyEvent(client: Client) {
  client.once('clientReady', async (c) => {
    attachClientToLogger(c)
    logger.info(`Logged in as ${c.user.tag}`)
    startHealthPush()
    // Load runtime settings FIRST so initPresence can read the persisted
    // `presence.last_used_at` from the cache. The other caches don't gate
    // anything on the boot path, so they run in parallel after.
    await loadSettings().catch(err => logger.error('Failed to load settings on startup', err))
    initPresence(c)

    // Discord drops the bot's activity on every gateway resume — without
    // these the "/help • Xm" status disappears whenever the connection
    // blips and stays gone until someone runs a command.
    client.on('shardResume', () => { refreshPresence() })
    client.on('shardReady', () => { refreshPresence() })

    await Promise.all([
      loadGames().catch(err => logger.error('Failed to load games on startup', err)),
      loadSocialFeeds().catch(err => logger.error('Failed to load social feeds on startup', err)),
      logResolvedBotOwners(c).catch(err => logger.warn('Bot-owner resolution failed on startup', err)),
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

    // Build a richer startup DM. Only the BOT_OWNER_ID env target gets this
    // (logger.dmOwner reads env directly — not the dynamic isBotOwner set).
    let version = '?'
    try {
      const pkg = await import('../../../package.json' as any)
      version = (pkg as any).version ?? '?'
    } catch {}
    const sha = (process.env.GIT_SHA ?? process.env.SOURCE_COMMIT ?? '').slice(0, 7) || 'unset'
    const nowSec = Math.floor(Date.now() / 1000)

    // List disabled feature flags so a stale "off" isn't surprising.
    const flagKeys: [string, string, boolean][] = [
      ['feature.auto_voice',         'Auto Voice',        true],
      ['feature.auto_threads',       'Auto Threads',      true],
      ['feature.social_poller',      'Social Poller',     true],
      ['feature.presence_renames',   'Presence Renames',  true],
      ['feature.birthday_pings',     'Birthday Pings',    true],
      ['feature.auto_role_on_join',  'Auto-role on join', false],
      ['feature.color_roles',        'Color Roles',       false],
    ]
    const offFlags = flagKeys.filter(([k, , def]) => !getBoolSetting(k, def)).map(([, label]) => label)

    const lines: string[] = [
      '## 🟢 SquishyBot is up',
      '',
      `**${c.user.tag}** · booted <t:${nowSec}:R>`,
      `**Version:** \`${version}\` · **Build:** \`${sha}\``,
      `**Primary guild:** ${guildName} (\`${env.GUILD_ID}\`)`,
    ]
    if (otherGuilds.length > 0) lines.push(`**Also in:** ${otherGuilds.join(', ')}`)
    lines.push('')
    if (result) {
      lines.push('### 🔧 Reconciler')
      lines.push(`• Recovered: **${result.recovered}**`)
      lines.push(`• Cleaned: **${result.cleaned}**`)
      lines.push(`• Hubs: **${result.hubs}**`)
      lines.push(`• Panels rebuilt: **${result.panels}**`)
      lines.push('')
    }
    lines.push('### 🚦 Feature flags')
    lines.push(offFlags.length === 0 ? '_All defaults active._' : `_Disabled:_ ${offFlags.join(', ')}`)
    lines.push('')
    lines.push('_Ready to roll. Run `/sudo` for the admin panel._')

    // Silent — successful boot is informational, not a notification.
    await logger.dmOwner(lines.join('\n'), c, { silent: true })
  })
}
