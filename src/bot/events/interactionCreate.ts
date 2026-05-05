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
import { execute as helpExecute } from '../../commands/help'
import { execute as sudoExecute } from '../../commands/sudo'
import { execute as staffExecute } from '../../commands/staff'
import { isVcCustomId } from '../../utils/customId'

const commandHandlers = new Map<string, (i: ChatInputCommandInteraction) => Promise<void>>([
  ['squishy', squishyExecute],
  ['voice', voiceExecute],
  ['help', helpExecute],
  ['sudo', sudoExecute],
  ['staff', staffExecute],
])

export function registerInteractionCreate(client: Client) {
  client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const handler = commandHandlers.get(interaction.commandName)
        if (handler) await handler(interaction)

      } else if (interaction.isButton()) {
        const id = interaction.customId
        if (isVcCustomId(id)) {
          const { handleVoiceControlButton } = await import('../../interactions/buttons/voiceControl')
          await handleVoiceControlButton(interaction as ButtonInteraction)
        } else if (id.startsWith('staff:')) {
          const { handleStaffApprovalButton } = await import('../../interactions/buttons/staffApproval')
          await handleStaffApprovalButton(interaction as ButtonInteraction)
        }

      } else if (interaction.isStringSelectMenu()) {
        if (isVcCustomId(interaction.customId)) {
          const { handleVoiceControlSelect } = await import('../../interactions/selects/voiceControl')
          await handleVoiceControlSelect(interaction as StringSelectMenuInteraction)
        }

      } else if (interaction.isModalSubmit()) {
        const id = interaction.customId
        if (isVcCustomId(id)) {
          const { handleVoiceRenameModal } = await import('../../interactions/modals/voiceRename')
          await handleVoiceRenameModal(interaction as ModalSubmitInteraction)
        } else if (id === 'staff:request') {
          const { handleStaffRequestModal } = await import('../../interactions/modals/staffRequest')
          await handleStaffRequestModal(interaction as ModalSubmitInteraction)
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
