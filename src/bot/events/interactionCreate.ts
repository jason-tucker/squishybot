import {
  type Client,
  type Interaction,
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
} from 'discord.js'
import { execute as squishyExecute } from '../../commands/squishy'
import { execute as voiceExecute } from '../../commands/voice'
import { isVcCustomId } from '../../utils/customId'

const commandHandlers = new Map<string, (i: ChatInputCommandInteraction) => Promise<void>>([
  ['squishy', squishyExecute],
  ['voice', voiceExecute],
])

export function registerInteractionCreate(client: Client) {
  client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const handler = commandHandlers.get(interaction.commandName)
        if (handler) await handler(interaction)

      } else if (interaction.isButton()) {
        if (isVcCustomId(interaction.customId)) {
          const { handleVoiceControlButton } = await import('../../interactions/buttons/voiceControl')
          await handleVoiceControlButton(interaction as ButtonInteraction)
        }

      } else if (interaction.isStringSelectMenu()) {
        if (isVcCustomId(interaction.customId)) {
          const { handleVoiceControlSelect } = await import('../../interactions/selects/voiceControl')
          await handleVoiceControlSelect(interaction as StringSelectMenuInteraction)
        }

      } else if (interaction.isModalSubmit()) {
        if (isVcCustomId(interaction.customId)) {
          const { handleVoiceRenameModal } = await import('../../interactions/modals/voiceRename')
          await handleVoiceRenameModal(interaction as ModalSubmitInteraction)
        }
      }
    } catch (err) {
      console.error('Interaction error:', err)
      const reply = { content: '❌ An unexpected error occurred.', ephemeral: true }
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
