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
import { logger } from './services/logger'
import { setDnd, shutdownPresence } from './services/presence'

registerReadyEvent(client)
registerInteractionCreate(client)
registerVoiceStateUpdate(client)
registerMessageCreate(client)
registerPresenceUpdate(client)
registerGuildMemberAdd(client)
registerGuildMemberRemove(client)

process.on('unhandledRejection', async (reason) => {
  setDnd('Unhandled error — check logs')
  await logger.errorAndDm('Unhandled promise rejection', reason)
})

process.on('uncaughtException', async (err) => {
  setDnd('Uncaught exception — check logs')
  await logger.errorAndDm('Uncaught exception', err)
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
  try { await client.destroy() } catch (err) { logger.warn('client.destroy failed', err) }
  // Give postgres pool sockets a moment to flush; node will exit naturally
  // once the event loop drains. 2 s is plenty in practice.
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })
process.on('SIGINT',  () => { void gracefulShutdown('SIGINT') })

client.login(env.DISCORD_BOT_TOKEN)
