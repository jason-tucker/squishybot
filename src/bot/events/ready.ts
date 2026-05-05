import type { Client } from 'discord.js'
import { startHealthPush } from '../healthPush'
import { runReconciler } from '../../services/voice/reconciler'
import { logger } from '../../services/logger'

export function registerReadyEvent(client: Client) {
  client.once('clientReady', async (c) => {
    logger.info(`Logged in as ${c.user.tag}`)
    startHealthPush()
    await runReconciler(c).catch(err => logger.error('Reconciler failed on startup:', err))
  })
}
