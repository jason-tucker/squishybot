import 'dotenv/config'
import { env } from './config/env'
import { client } from './bot/client'
import { registerReadyEvent } from './bot/events/ready'
import { registerInteractionCreate } from './bot/events/interactionCreate'
import { registerVoiceStateUpdate } from './bot/events/voiceStateUpdate'
import { registerMessageCreate } from './bot/events/messageCreate'
import { registerPresenceUpdate } from './bot/events/presenceUpdate'
import { registerGuildMemberAdd } from './bot/events/guildMemberAdd'
import { registerGuildMemberRemove } from './bot/events/guildMemberRemove'
import { registerMessageReaction } from './bot/events/messageReaction'
import { logger } from './services/logger'
import { setDnd, shutdownPresence } from './services/presence'
import { shutdownActivityTracker } from './services/activity/tracker'

registerReadyEvent(client)
registerInteractionCreate(client)
registerVoiceStateUpdate(client)
registerMessageCreate(client)
registerPresenceUpdate(client)
registerGuildMemberAdd(client)
registerGuildMemberRemove(client)
registerMessageReaction(client)

// Non-fatal: a stray rejection is reported (owner DM deduped by the logger's
// DmThrottle) and the bot keeps running.
process.on('unhandledRejection', (reason) => {
  try { setDnd('Unhandled error — check logs') } catch { /* presence is best effort */ }
  void logger.errorAndDm('Unhandled promise rejection', reason).catch(() => {})
})

/**
 * After an uncaught exception the process state is unknown, so report and
 * exit(1); Docker's `restart: unless-stopped` brings the bot back. Every
 * restart re-identifies to Discord (which resets the token after about 1000
 * identifies per day), so the exit is held until the process has been up for
 * CRASH_MIN_UPTIME_MS: a crash loop restarts at most once per 2 minutes.
 */
const CRASH_DM_TIMEOUT_MS = 5_000
const CRASH_FLUSH_TIMEOUT_MS = 2_000
const CRASH_DESTROY_TIMEOUT_MS = 2_000
const CRASH_MIN_UPTIME_MS = 120_000
let crashing = false

function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    work.then(
      () => { clearTimeout(timer); resolve() },
      () => { clearTimeout(timer); resolve() },
    )
  })
}

async function exitAfterCrash(err: unknown): Promise<void> {
  await settleWithin(
    logger.errorAndDm('Uncaught exception — restarting', err, undefined, { critical: true }),
    CRASH_DM_TIMEOUT_MS,
  )
  await settleWithin(shutdownActivityTracker(), CRASH_FLUSH_TIMEOUT_MS)
  // Stop handling Discord events in the unknown state while the uptime guard holds.
  await settleWithin(Promise.resolve().then(() => client.destroy()), CRASH_DESTROY_TIMEOUT_MS)
  const waitMs = Math.max(0, CRASH_MIN_UPTIME_MS - process.uptime() * 1000)
  if (waitMs > 0) {
    logger.warn(`Delaying crash exit by ${Math.round(waitMs / 1000)}s (minimum uptime guard against a restart loop)`)
    await new Promise(resolve => setTimeout(resolve, waitMs))
  }
  process.exit(1)
}

process.on('uncaughtException', (err) => {
  if (crashing) {
    logger.error('Uncaught exception while already shutting down after a crash', err)
    return
  }
  crashing = true
  try { setDnd('Uncaught exception — restarting') } catch { /* presence is best effort */ }
  exitAfterCrash(err).catch(() => process.exit(1))
})

/**
 * Graceful shutdown on SIGTERM (the signal Docker sends on `docker stop` /
 * compose restart). Without this, the gateway connection drops abruptly,
 * the presence ticker keeps running until the kill timeout, and the
 * postgres pool sockets aren't drained — small edges, but together they
 * make the bot show "RECONNECTING" in Discord for a few seconds longer
 * than necessary on every deploy.
 */
let shuttingDown = false
async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`Received ${signal} — shutting down gracefully`)
  shutdownPresence()
  // Drain the activity buffers + persist voice watermarks BEFORE the gateway
  // drops — watchtower deploys hit this path routinely, and without it the
  // last ≤30s of activity counts would be discarded on every deploy.
  try { await shutdownActivityTracker() } catch (err) { logger.warn('activity shutdown flush failed', err) }
  try { await client.destroy() } catch (err) { logger.warn('client.destroy failed', err) }
  // Give postgres pool sockets a moment to flush; node will exit naturally
  // once the event loop drains. 2 s is plenty in practice.
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })
process.on('SIGINT',  () => { void gracefulShutdown('SIGINT') })

client.login(env.DISCORD_BOT_TOKEN)
