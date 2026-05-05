import { REST, Routes } from 'discord.js'
import { env } from '../config/env'
import { data as squishyData } from '../commands/squishy'
import { data as voiceData } from '../commands/voice'

const commands = [
  squishyData.toJSON(),
  voiceData.toJSON(),
]

const rest = new REST().setToken(env.DISCORD_BOT_TOKEN)

async function deploy() {
  await rest.put(
    Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.GUILD_ID),
    { body: commands }
  )
  console.log(`✅ Deployed ${commands.length} command(s) to guild ${env.GUILD_ID}.`)
}

deploy().catch((err) => {
  console.error('Failed to deploy commands:', err)
  process.exit(1)
})
