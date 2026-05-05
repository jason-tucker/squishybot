import {
  type Client,
  type Interaction,
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  UserContextMenuCommandInteraction,
} from 'discord.js'
import { execute as voiceExecute } from '../../commands/voice'
import { execute as staffExecute } from '../../commands/staff'
import { execute as sudoExecute } from '../../commands/sudo'
import { execute as manageUserExecute } from '../../commands/manageUser'
import { isVcCustomId } from '../../utils/customId'
import { recordActivity } from '../../services/presence'

const commandHandlers = new Map<string, (i: ChatInputCommandInteraction) => Promise<void>>([
  ['voice', voiceExecute],
  ['staff', staffExecute],
  ['sudo', sudoExecute],
])

export function registerInteractionCreate(client: Client) {
  client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      recordActivity()

      if (interaction.isChatInputCommand()) {
        const handler = commandHandlers.get(interaction.commandName)
        if (handler) await handler(interaction)

      } else if (interaction.isUserContextMenuCommand()) {
        if (interaction.commandName === 'Manage User') {
          await manageUserExecute(interaction as UserContextMenuCommandInteraction)
        }

      } else if (interaction.isButton()) {
        const id = interaction.customId
        if (isVcCustomId(id)) {
          const { handleVoiceControlButton } = await import('../../interactions/buttons/voiceControl')
          await handleVoiceControlButton(interaction as ButtonInteraction)
        } else if (id.startsWith('staff:')) {
          const { handleStaffApprovalButton } = await import('../../interactions/buttons/staffApproval')
          await handleStaffApprovalButton(interaction as ButtonInteraction)
        } else if (id.startsWith('sudo_user:')) {
          const { handleSudoUserButton } = await import('../../interactions/buttons/sudoUser')
          await handleSudoUserButton(interaction as ButtonInteraction)
        }

      } else if (interaction.isStringSelectMenu()) {
        const id = interaction.customId
        if (isVcCustomId(id)) {
          const { handleVoiceControlSelect } = await import('../../interactions/selects/voiceControl')
          await handleVoiceControlSelect(interaction as StringSelectMenuInteraction)
        } else if (id === 'sudo:action') {
          const { handleSudoPanelSelect } = await import('../../interactions/selects/sudoPanel')
          await handleSudoPanelSelect(interaction as StringSelectMenuInteraction)
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
