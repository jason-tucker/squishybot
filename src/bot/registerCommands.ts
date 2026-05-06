import { REST, Routes } from 'discord.js'
import { env } from '../config/env'
import { data as voiceData } from '../commands/voice'
import { data as squishyData } from '../commands/squishy'
import { data as sudoData } from '../commands/sudo'
import { data as manageUserData } from '../commands/manageUser'
import { data as reportData } from '../commands/report'
import { data as profileData } from '../commands/profile'

const commands = [
  voiceData.toJSON(),    // /voice  — voice channel control panel
  squishyData.toJSON(),  // /squishy — user menu (bot info + staff request)
  sudoData.toJSON(),     // /sudo   — admin panel (sudo only)
  reportData.toJSON(),   // /report — file a GitHub issue
  profileData.toJSON(),  // /profile — self-service profile editor
  manageUserData.toJSON(), // right-click → Manage User (context menu, sudo only)
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
