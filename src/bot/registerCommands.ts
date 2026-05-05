import { REST, Routes } from 'discord.js'
import { env } from '../config/env'

// Import command data here:
// import { data as myCommandData } from '../commands/myCommand'

const commands = [
  // myCommandData.toJSON(),
]

const rest = new REST().setToken(env.DISCORD_BOT_TOKEN)

async function deploy() {
  // Guild deploy (instant) — replace with your guild ID or load from config
  // await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildId), { body: commands })

  // Global deploy (up to 1 hour propagation)
  await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body: commands })
  console.log(`Deployed ${commands.length} command(s) globally.`)
}

deploy().catch((err) => {
  console.error('Failed to deploy commands:', err)
  process.exit(1)
})
