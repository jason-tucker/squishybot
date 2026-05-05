import type { Client } from 'discord.js'
import { startHealthPush } from '../healthPush'

export function registerReadyEvent(client: Client) {
  client.once('clientReady', async (c) => {
    console.log(`Logged in as ${c.user.tag}`)
    startHealthPush()
  })
}
