import 'dotenv/config'
import { env } from './config/env'
import { client } from './bot/client'
import { registerReadyEvent } from './bot/events/ready'
import { registerInteractionCreate } from './bot/events/interactionCreate'
import { registerVoiceStateUpdate } from './bot/events/voiceStateUpdate'
import { logger } from './services/logger'

registerReadyEvent(client)
registerInteractionCreate(client)
registerVoiceStateUpdate(client)

process.on('unhandledRejection', async (reason) => {
  await logger.errorAndDm('Unhandled promise rejection', reason)
})

process.on('uncaughtException', async (err) => {
  await logger.errorAndDm('Uncaught exception', err)
})

client.login(env.DISCORD_BOT_TOKEN)
