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
import { execute as squishyExecute } from '../../commands/squishy'
import { execute as sudoExecute } from '../../commands/sudo'
import { execute as manageUserExecute } from '../../commands/manageUser'
import { execute as reportExecute } from '../../commands/report'
import { execute as profileExecute } from '../../commands/profile'
import { isVcCustomId } from '../../utils/customId'
import { recordActivity } from '../../services/presence'

const commandHandlers = new Map<string, (i: ChatInputCommandInteraction) => Promise<void>>([
  ['voice', voiceExecute],
  ['squishy', squishyExecute],
  ['sudo', sudoExecute],
  ['report', reportExecute],
  ['profile', profileExecute],
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
        } else if (id === 'squishy:back') {
          const member = await interaction.guild!.members.fetch(interaction.user.id)
          const { sendMainPanel } = await import('../../commands/squishy')
          const { isSudo } = await import('../../services/voice/permissions')
          await sendMainPanel(interaction as any, isSudo(member))
        } else if (id === 'open_staff_request') {
          const { showStaffRequestModal } = await import('../../commands/staff')
          await showStaffRequestModal(interaction as ButtonInteraction)
        } else if (id.startsWith('staff:')) {
          const { handleStaffApprovalButton } = await import('../../interactions/buttons/staffApproval')
          await handleStaffApprovalButton(interaction as ButtonInteraction)
        } else if (id.startsWith('sudo_user:')) {
          const { handleSudoUserButton } = await import('../../interactions/buttons/sudoUser')
          await handleSudoUserButton(interaction as ButtonInteraction)
        } else if (id.startsWith('report_approve_') || id.startsWith('report_reject_')) {
          const { handleReportReview } = await import('../../interactions/buttons/reportReview')
          await handleReportReview(interaction as ButtonInteraction)
        } else if (id.startsWith('sudo:set:')) {
          const { handleSettingsButton } = await import('../../interactions/sudoSettings')
          await handleSettingsButton(interaction as ButtonInteraction)
        } else if (id.startsWith('profile:edit:')) {
          const { handleProfileEditButton } = await import('../../interactions/profileEditor')
          await handleProfileEditButton(interaction as ButtonInteraction)
        } else if (id.startsWith('profile:toggle:')) {
          const { handleProfileToggle } = await import('../../interactions/profileEditor')
          await handleProfileToggle(interaction as ButtonInteraction)
        } else if (id.startsWith('profile:back:')) {
          const { handleProfileBack } = await import('../../interactions/profileEditor')
          await handleProfileBack(interaction as ButtonInteraction)
        }

      } else if (interaction.isChannelSelectMenu()) {
        const id = interaction.customId
        if (id.startsWith('sudo:set:channel:') || id === 'sudo:set:autothread:add' || id === 'sudo:set:hub:add') {
          const { handleSettingsChannelSelect } = await import('../../interactions/sudoSettings')
          await handleSettingsChannelSelect(interaction)
        }

      } else if (interaction.isUserSelectMenu()) {
        const id = interaction.customId
        if (id === 'sudo:set:adduser') {
          const { handleSettingsUserSelect } = await import('../../interactions/sudoSettings')
          await handleSettingsUserSelect(interaction)
        } else if (id === 'profile:select_user') {
          const { handleProfileUserSelect } = await import('../../interactions/profileEditor')
          await handleProfileUserSelect(interaction)
        }

      } else if (interaction.isStringSelectMenu()) {
        const id = interaction.customId
        if (isVcCustomId(id) && id.endsWith(':template_apply')) {
          const { handleVoiceTemplateSelect } = await import('../../interactions/selects/voiceTemplate')
          await handleVoiceTemplateSelect(interaction as StringSelectMenuInteraction)
        } else if (isVcCustomId(id)) {
          const { handleVoiceControlSelect } = await import('../../interactions/selects/voiceControl')
          await handleVoiceControlSelect(interaction as StringSelectMenuInteraction)
        } else if (id === 'sudo:action') {
          const { handleSudoPanelSelect } = await import('../../interactions/selects/sudoPanel')
          await handleSudoPanelSelect(interaction as StringSelectMenuInteraction)
        } else if (id === 'squishy:section') {
          const { handleSquishyPanelSelect } = await import('../../interactions/selects/squishyPanel')
          await handleSquishyPanelSelect(interaction as StringSelectMenuInteraction)
        } else if (id === 'sudo:set:removeuser' || id === 'sudo:set:reset_channel' || id === 'sudo:set:autothread:remove' || id === 'sudo:set:hub:remove') {
          const { handleSettingsStringSelect } = await import('../../interactions/sudoSettings')
          await handleSettingsStringSelect(interaction as StringSelectMenuInteraction)
        }

      } else if (interaction.isModalSubmit()) {
        const id = interaction.customId
        if (isVcCustomId(id)) {
          const { handleVoiceRenameModal } = await import('../../interactions/modals/voiceRename')
          await handleVoiceRenameModal(interaction as ModalSubmitInteraction)
        } else if (id === 'staff:request') {
          const { handleStaffRequestModal } = await import('../../interactions/modals/staffRequest')
          await handleStaffRequestModal(interaction as ModalSubmitInteraction)
        } else if (id === 'report:submit') {
          const { handleReportSubmit } = await import('../../interactions/modals/reportSubmit')
          await handleReportSubmit(interaction as ModalSubmitInteraction)
        } else if (id.startsWith('sudo:set:save:')) {
          const { handleSettingsModalSubmit } = await import('../../interactions/sudoSettings')
          await handleSettingsModalSubmit(interaction as ModalSubmitInteraction)
        } else if (id.startsWith('profile:save:')) {
          const { handleProfileModal } = await import('../../interactions/profileEditor')
          await handleProfileModal(interaction as ModalSubmitInteraction)
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
