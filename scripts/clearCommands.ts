import { REST, Routes } from 'discord.js'
import 'dotenv/config'

const token = process.env.DISCORD_BOT_TOKEN!
const clientId = process.env.DISCORD_CLIENT_ID!

const rest = new REST().setToken(token)

async function clear() {
  await rest.put(Routes.applicationCommands(clientId), { body: [] })
  console.log('✅ Cleared all global slash commands.')
}

clear().catch(console.error)
