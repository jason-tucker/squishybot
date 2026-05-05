import {
  type Client,
  type Interaction,
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
} from 'discord.js'

const commandHandlers = new Map<string, (i: ChatInputCommandInteraction) => Promise<void>>([
  // ['commandname', executeCommand],
])

export function registerInteractionCreate(client: Client) {
  client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const handler = commandHandlers.get(interaction.commandName)
        if (handler) await handler(interaction)

      } else if (interaction.isButton()) {
        const id = interaction.customId
        void id // add routing here: if (id.startsWith('prefix:')) ...

      } else if (interaction.isStringSelectMenu()) {
        const id = interaction.customId
        void id

      } else if (interaction.isModalSubmit()) {
        const id = interaction.customId
        void id
      }
    } catch (err) {
      console.error('Interaction error:', err)
      const reply = { content: 'An unexpected error occurred.', ephemeral: true }
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(reply).catch(() => {})
        } else {
          await interaction.reply(reply).catch(() => {})
        }
      }
    }
  })
}
