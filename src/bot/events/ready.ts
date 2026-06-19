import { ContainerBuilder, MessageFlags, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder, type Client } from 'discord.js'
import { startHealthPush } from '../healthPush'
import { runReconciler } from '../../services/voice/reconciler'
import { logger, attachClientToLogger } from '../../services/logger'
import { initPresence, refreshPresence } from '../../services/presence'
import { env } from '../../config/env'
import { loadSettings } from '../../services/settings'
import { loadGames } from '../../services/games'
import { loadSelfAssign } from '../../services/selfAssign'
import { loadSocialFeeds } from '../../services/socialFeeds'
import { startSocialPoller } from '../../services/social/poller'
import { startBirthdayScheduler } from '../../services/birthdayScheduler'
import { logResolvedBotOwners } from '../../services/botOwner'
import { getBoolSetting } from '../../services/settings'
import { publishHeartbeat, publishReady } from '../../services/eventBus'
import { startRpcServer } from '../../services/rpcServer'
import { startCacheInvalidator } from '../../services/cacheInvalidator'
// Side-effect import: registers the `echo` verb on the RPC registry.
// Follow-up PRs add more handlers; each one is a side-effect import too.
import '../../services/rpc/handlers/echo'
// Wave 7b — staff role grant/revoke verbs.
import '../../services/rpc/handlers/staff'
// Wave 7b — welcome/goodbye preview verb (read-only render of live templates).
import '../../services/rpc/handlers/admin'
// Wave 7b — games.refresh_cache verb (post-write cache reload hook).
import '../../services/rpc/handlers/games/refresh_cache'
// Wave 7b — games.set_prefs verb (batched per-user view/ping toggles from /me/games).
import '../../services/rpc/handlers/games/set_prefs'
// game.provision verb — atomic create-channel+two-roles+games-row for the
// panel's Add-Game "auto-provision" checkbox.
import '../../services/rpc/handlers/games/provision'
// discord.* low-level resource creators — called by the panel's "+ Create"
// inline buttons when a games-row link points at a deleted entity.
import '../../services/rpc/handlers/discord'
// report.submit verb — panel /report page mirrors the slash modal.
import '../../services/rpc/handlers/report'
// play.post verb — panel-triggered LFG post mirroring /play [message] [ping].
import '../../services/rpc/handlers/play'
// Wave 7b — reaction-role builder verbs (create/delete/expire).
import '../../services/rpc/handlers/rxnroles/create'
import '../../services/rpc/handlers/rxnroles/delete'
import '../../services/rpc/handlers/rxnroles/expire'
// Wave 7b: `hub.lockdown`, `hub.lockdown_all`, `hub.refresh_cache`.
import '../../services/rpc/handlers/hubs'
// Voice-control verbs (rename / lock / hide / disconnect / transfer / delete).
// The barrel side-effect-imports each handler module.
import '../../services/rpc/handlers/voice'
// Wave 7d — meta verbs for panel pickers (roles/channels/members).
import '../../services/rpc/handlers/meta'
// Wave 7d — users.resolve verb (snowflake→@username for panel display).
import '../../services/rpc/handlers/users'
// color.assign verb — sudo applies / clears a curated color role for any
// member from the panel members editor. The public `/color` slash command
// stays gated on `feature.color_roles`; the verb itself isn't double-gated
// (panel hides the section when the flag is off, see /squishy/members/[id]).
import '../../services/rpc/handlers/color'
// scheduled_post.send / .cancel verbs — panel "Send now" + live-post retract.
import '../../services/rpc/handlers/scheduledPosts/send'
import '../../services/rpc/handlers/scheduledPosts/cancel'
// Self-assign board verbs (add / update / remove / reorder / set_channel / publish).
import '../../services/rpc/handlers/selfAssign'

const SUPPRESS_NOTIFICATIONS = 1 << 12  // MessageFlags.SuppressNotifications

function sep() {
  return new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
}

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
      loadSelfAssign().catch(err => logger.error('Failed to load self-assign board on startup', err)),
    ])
    startBirthdayScheduler(c)
    startSocialPoller(c)
    const { startScheduledPostScheduler } = await import('../../services/scheduledPosts/scheduler')
    startScheduledPostScheduler(c)
    const { startGameAutoArchiver } = await import('../../services/gameAutoArchive')
    startGameAutoArchiver(c, env.GUILD_ID)
    const { loadReactionRoles, startReactionRoleCleanup } = await import('../../services/reactionRoles')
    await loadReactionRoles().catch(err => logger.error('Failed to load reaction roles on startup', err))
    startReactionRoleCleanup(c)

    // Redis fan-out — one-shot ready event + 60s heartbeat. Both go on
    // bot.squishy.bot.{ready,heartbeat}. publishHeartbeat is non-blocking
    // and never throws (eventBus.publish wraps errors in logger.warn), so
    // a downed Redis won't impact the bot.
    void publishReady(c)
    setInterval(() => { void publishHeartbeat(c) }, 60_000)

    const guild = c.guilds.cache.get(env.GUILD_ID)
    const guildName = guild?.name ?? '(not a member)'
    const otherGuilds = c.guilds.cache.filter(g => g.id !== env.GUILD_ID).map(g => `${g.name} (${g.id})`)

    let result
    try {
      result = await runReconciler(c)
    } catch (err) {
      await logger.errorAndDm('Reconciler failed on startup', err, c)
    }

    // Wave 7 command bus — bot-side RPC subscriber. Lazy ioredis client
    // psubscribes to `cmd.squishy.*` and dispatches HMAC-verified
    // envelopes to verb handlers from `services/rpc/registry`. Non-
    // blocking: if `BOTPANEL_RPC_SECRET` is unset or Redis is down the
    // bot still boots normally. Runs after the reconciler so handlers
    // see a settled channel state.
    startRpcServer(c)

    // V3-1 cache-invalidate subscriber — listens on
    // `bot.squishy.settings.invalidate` for HMAC-signed events from
    // botpanel and reloads in-memory caches (settings, games, hubs, …)
    // without a bot restart. Non-blocking; logs and skips if
    // BOTPANEL_RPC_SECRET is unset. Tracks #33 / botpanel V3-1.
    startCacheInvalidator()

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

    // Build a Components V2 card. Visually richer than markdown — colored
    // accent bar on the side, distinct sections separated by dividers.
    const headerLines = [
      `**${c.user.tag}** · booted <t:${nowSec}:R>`,
      `**Version** \`${version}\` · **Build** \`${sha}\``,
      `**Primary guild** ${guildName} (\`${env.GUILD_ID}\`)`,
    ]
    if (otherGuilds.length > 0) headerLines.push(`**Also in** ${otherGuilds.join(', ')}`)

    const container = new ContainerBuilder()
      .setAccentColor(0x57f287)  // green = healthy boot
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🟢 SquishyBot is up'))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')))

    if (result) {
      container.addSeparatorComponents(sep()).addTextDisplayComponents(new TextDisplayBuilder().setContent(
        '### 🔧 Reconciler\n' +
        `• Recovered **${result.recovered}**\n` +
        `• Cleaned **${result.cleaned}**\n` +
        `• Hubs **${result.hubs}**\n` +
        `• Panels rebuilt **${result.panels}**`
      ))
    }

    container.addSeparatorComponents(sep()).addTextDisplayComponents(new TextDisplayBuilder().setContent(
      '### 🚦 Feature flags\n' +
      (offFlags.length === 0 ? '_All defaults active._' : `_Disabled:_ ${offFlags.join(', ')}`)
    ))

    container.addSeparatorComponents(sep()).addTextDisplayComponents(new TextDisplayBuilder().setContent(
      '_Ready to roll. Run `/sudo` for the admin panel._'
    ))

    // Silent — successful boot is informational, not a notification.
    // logger.dmOwner only supports plain content; send the CV2 payload directly.
    if (env.BOT_OWNER_ID) {
      const owner = await c.users.fetch(env.BOT_OWNER_ID).catch(() => null)
      if (owner) {
        await owner.send({
          flags: (MessageFlags.IsComponentsV2 as number) | SUPPRESS_NOTIFICATIONS,
          components: [container],
        } as any).catch(() => {})
      }
    }
  })
}
