import { Client, GatewayIntentBits, Partials } from 'discord.js'

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,  // privileged — enable in Dev Portal → Bot → Message Content Intent (needed for auto-thread name templating)
    GatewayIntentBits.GuildPresences, // privileged — enable in Dev Portal → Bot → Presence Intent
  ],
  partials: [Partials.GuildMember],
})
