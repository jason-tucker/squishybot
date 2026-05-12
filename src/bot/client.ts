import { Client, GatewayIntentBits, Partials } from 'discord.js'

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,  // privileged — enable in Dev Portal → Bot → Message Content Intent (needed for auto-thread name templating)
    GatewayIntentBits.GuildPresences, // privileged — enable in Dev Portal → Bot → Presence Intent
    GatewayIntentBits.GuildMessageReactions,  // #37 reaction-role messages
  ],
  // Partials.Message + Partials.Reaction so reaction events fire for messages
  // that aren't in the in-memory message cache (anything older than process
  // start, basically — including all reaction-role messages after a restart).
  partials: [Partials.GuildMember, Partials.Message, Partials.Reaction],
  // Default every reply / send / followUp to "no mentions resolve". Individual
  // call sites that legitimately need to ping (e.g. /play LFG ping role,
  // birthday channel ping) override this explicitly with `allowedMentions:
  // { roles: [...] }` / `{ users: [...] }`. Defending against a stray
  // @everyone in any user-supplied text (Game Night notes, voice rename,
  // staff-request reason, /report description, social-feed item body, etc.).
  allowedMentions: { parse: [] },
})
