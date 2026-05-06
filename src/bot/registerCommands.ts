import { REST, Routes } from 'discord.js'
import { env } from '../config/env'
import { data as voiceData } from '../commands/voice'
import { data as squishyData } from '../commands/squishy'
import { data as sudoData } from '../commands/sudo'
import { data as manageUserData } from '../commands/manageUser'
import { data as reportData } from '../commands/report'
import { data as gamesData } from '../commands/games'
import { data as playData } from '../commands/play'

const commands = [
  voiceData.toJSON(),    // /voice  — voice channel control panel
  squishyData.toJSON(),  // /squishy — user menu (bot info, profile editor, staff request)
  sudoData.toJSON(),     // /sudo   — admin panel (sudo only)
  reportData.toJSON(),   // /report — file a GitHub issue
  gamesData.toJSON(),    // /games — pick games for View / Pings (self mode)
  playData.toJSON(),     // /play — LFG ping for a game
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
