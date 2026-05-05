import 'dotenv/config'
import { env } from './config/env'
import { client } from './bot/client'
import { registerReadyEvent } from './bot/events/ready'
import { registerInteractionCreate } from './bot/events/interactionCreate'

registerReadyEvent(client)
registerInteractionCreate(client)

client.login(env.DISCORD_BOT_TOKEN)
