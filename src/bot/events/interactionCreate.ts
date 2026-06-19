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
import { execute as helpExecute } from '../../commands/help'
import { execute as settingsExecute } from '../../commands/settings'
import { execute as sudoExecute } from '../../commands/sudo'
import { execute as manageUserExecute } from '../../commands/manageUser'
import { execute as reportExecute } from '../../commands/report'
import { execute as gamesExecute } from '../../commands/games'
import { execute as playExecute, autocomplete as playAutocomplete } from '../../commands/play'
import { execute as colorExecute } from '../../commands/color'
import { isVcCustomId } from '../../utils/customId'
import { recordActivity } from '../../services/presence'

const commandHandlers = new Map<string, (i: ChatInputCommandInteraction) => Promise<void>>([
  ['voice', voiceExecute],
  ['help', helpExecute],
  ['settings', settingsExecute],
  ['sudo', sudoExecute],
  ['report', reportExecute],
  ['games', gamesExecute],
  ['play', playExecute],
  ['color', colorExecute],
])

export function registerInteractionCreate(client: Client) {
  client.on('interactionCreate', async (interaction: Interaction) => {
    try {
      recordActivity()

      if (interaction.isChatInputCommand()) {
        const handler = commandHandlers.get(interaction.commandName)
        if (handler) await handler(interaction)

      } else if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'play') {
          await playAutocomplete(interaction)
        }

      } else if (interaction.isUserContextMenuCommand()) {
        if (interaction.commandName === 'Manage') {
          await manageUserExecute(interaction as UserContextMenuCommandInteraction)
        }

      } else if (interaction.isButton()) {
        const id = interaction.customId
        if (isVcCustomId(id)) {
          const { handleVoiceControlButton } = await import('../../interactions/buttons/voiceControl')
          await handleVoiceControlButton(interaction as ButtonInteraction)
        } else if (id === 'help:back') {
          const member = await interaction.guild!.members.fetch(interaction.user.id)
          const { sendHelpPanel } = await import('../../commands/help')
          const { isSudo } = await import('../../services/voice/permissions')
          await sendHelpPanel(interaction as any, isSudo(member))
        } else if (id === 'settings:home') {
          const { handleSettingsHomeButton } = await import('../../commands/settings')
          await handleSettingsHomeButton(interaction as ButtonInteraction)
        } else if (id === 'settings:profile') {
          const { handleSettingsProfileButton } = await import('../../commands/settings')
          await handleSettingsProfileButton(interaction as ButtonInteraction)
        } else if (id === 'settings:games') {
          const { handleSettingsGamesButton } = await import('../../commands/settings')
          await handleSettingsGamesButton(interaction as ButtonInteraction)
        } else if (id === 'settings:staff_role') {
          const { handleStaffRoleSelfButton } = await import('../../interactions/staffRoleSelf')
          await handleStaffRoleSelfButton(interaction as ButtonInteraction)
        } else if (id.startsWith('settings:staff_role:add:')) {
          const { handleStaffRoleSelfAdd } = await import('../../interactions/staffRoleSelf')
          await handleStaffRoleSelfAdd(interaction as ButtonInteraction)
        } else if (id.startsWith('settings:staff_role:remove:')) {
          const { handleStaffRoleSelfRemove } = await import('../../interactions/staffRoleSelf')
          await handleStaffRoleSelfRemove(interaction as ButtonInteraction)
        } else if (id === 'open_staff_request') {
          const { showStaffRolePicker } = await import('../../commands/staff')
          await showStaffRolePicker(interaction as ButtonInteraction)
        } else if (id.startsWith('staff:request_open:')) {
          const { handleStaffRequestOpenButton } = await import('../../commands/staff')
          await handleStaffRequestOpenButton(interaction as ButtonInteraction)
        } else if (id.startsWith('staff:approve:') || id.startsWith('staff:deny:')) {
          const { handleStaffApprovalButton } = await import('../../interactions/buttons/staffApproval')
          await handleStaffApprovalButton(interaction as ButtonInteraction)
        } else if (id.startsWith('sudo_user:')) {
          const { handleSudoUserButton } = await import('../../interactions/buttons/sudoUser')
          await handleSudoUserButton(interaction as ButtonInteraction)
        } else if (id.startsWith('report_approve_') || id.startsWith('report_reject_')) {
          const { handleReportReview } = await import('../../interactions/buttons/reportReview')
          await handleReportReview(interaction as ButtonInteraction)
        } else if (id === 'sudo:home') {
          const { handleSudoHomeButton } = await import('../../commands/sudo')
          await handleSudoHomeButton(interaction as ButtonInteraction)
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
        } else if (id.startsWith('play:join:')) {
          const { handleJoinButton } = await import('../../commands/play')
          await handleJoinButton(interaction as ButtonInteraction)
        } else if (id.startsWith('play:cancel:')) {
          const { handleCancelButton } = await import('../../commands/play')
          await handleCancelButton(interaction as ButtonInteraction)
        } else if (id.startsWith('play:help:')) {
          const { handleHelpButton } = await import('../../commands/play')
          await handleHelpButton(interaction as ButtonInteraction)
        } else if (id.startsWith('play:notify:')) {
          const { handleNotifyToggleButton } = await import('../../commands/play')
          await handleNotifyToggleButton(interaction as ButtonInteraction)
        } else if (id.startsWith('sar:')) {
          const { handleSelfAssignButton } = await import('../../interactions/buttons/selfAssign')
          await handleSelfAssignButton(interaction as ButtonInteraction)
        } else if (id.startsWith('gn:preview:')) {
          const { handlePreviewButton } = await import('../../commands/gamenight')
          await handlePreviewButton(interaction as ButtonInteraction)
        } else if (id.startsWith('gn:rsvp:')) {
          const { handleRsvpButton } = await import('../../commands/gamenight')
          await handleRsvpButton(interaction as ButtonInteraction)
        } else if (id.startsWith('gn:own:')) {
          const { handleOwnershipButton } = await import('../../commands/gamenight')
          await handleOwnershipButton(interaction as ButtonInteraction)
        } else if (id.startsWith('gn:cancel:')) {
          const { handleCancelButton: handleGnCancel } = await import('../../commands/gamenight')
          await handleGnCancel(interaction as ButtonInteraction)
        } else if (id.startsWith('sp:rsvp:') || id.startsWith('sp:own:') || id.startsWith('sp:cancel:')) {
          const { handleScheduledPostButton } = await import('../../interactions/buttons/scheduledPost')
          await handleScheduledPostButton(interaction as ButtonInteraction)
        } else if (id.startsWith('games:cat:')) {
          const { handleCatalogButton } = await import('../../interactions/gamesEditor')
          await handleCatalogButton(interaction as ButtonInteraction)
        } else if (id.startsWith('games:prefs:set:')) {
          const { handlePrefsSet } = await import('../../interactions/gamesEditor')
          await handlePrefsSet(interaction as ButtonInteraction)
        } else if (id.startsWith('games:prefs:list:')) {
          const { handlePrefsList } = await import('../../interactions/gamesEditor')
          await handlePrefsList(interaction as ButtonInteraction)
        } else if (id.startsWith('games:prefs:back:')) {
          const { handlePrefsBack } = await import('../../interactions/gamesEditor')
          await handlePrefsBack(interaction as ButtonInteraction)
        } else if (id.startsWith('games:mass:open:')) {
          const { handleMassOpen } = await import('../../interactions/gamesEditor')
          await handleMassOpen(interaction as ButtonInteraction)
        } else if (id.startsWith('games:defaults:') || id.startsWith('games:bulk:')) {
          const { handleGameDefaultsButton } = await import('../../interactions/gamesEditor')
          await handleGameDefaultsButton(interaction as ButtonInteraction)
        }

      } else if (interaction.isChannelSelectMenu()) {
        const id = interaction.customId
        if (id.startsWith('sudo:set:channel:') || id === 'sudo:set:autothread:add' || id === 'sudo:set:hub:add') {
          const { handleSettingsChannelSelect } = await import('../../interactions/sudoSettings')
          await handleSettingsChannelSelect(interaction)
        } else if (id.startsWith('games:cat:channel:') || id === 'games:cat:set_category') {
          const { handleCatalogChannelSelect } = await import('../../interactions/gamesEditor')
          await handleCatalogChannelSelect(interaction)
        }

      } else if (interaction.isUserSelectMenu()) {
        const id = interaction.customId
        if (id === 'sudo:set:adduser') {
          const { handleSettingsUserSelect } = await import('../../interactions/sudoSettings')
          await handleSettingsUserSelect(interaction)
        } else if (id === 'profile:select_user') {
          const { handleProfileUserSelect } = await import('../../interactions/profileEditor')
          await handleProfileUserSelect(interaction)
        } else if (id === 'sudo:manage_user_pick') {
          const { requireSudo } = await import('../../services/voice/permissions')
          if (!await requireSudo(interaction)) return
          const targetId = interaction.values[0]
          const { renderManagePanel } = await import('../../commands/manageUser')
          await interaction.update(await renderManagePanel(interaction.guild!, targetId) as any)
        } else if (id.startsWith('sudo:force_owner:user_pick:')) {
          const { handleForceOwnerUserPick } = await import('../../interactions/forceOwnerTransfer')
          await handleForceOwnerUserPick(interaction)
        }

      } else if (interaction.isRoleSelectMenu()) {
        const id = interaction.customId
        if (id.startsWith('games:cat:role:')) {
          const { handleCatalogRoleSelect } = await import('../../interactions/gamesEditor')
          await handleCatalogRoleSelect(interaction)
        } else if (id === 'sudo:set:auto_role:add' || id === 'sudo:set:color_role:add') {
          const { handleSettingsRoleSelect } = await import('../../interactions/sudoSettings')
          await handleSettingsRoleSelect(interaction)
        }

      } else if (interaction.isStringSelectMenu()) {
        const id = interaction.customId
        if (isVcCustomId(id)) {
          // All vc:* selects route here (currently just the Hosts picker; the
          // legacy template_apply select was removed with the templates redesign).
          const { handleVoiceControlSelect } = await import('../../interactions/selects/voiceControl')
          await handleVoiceControlSelect(interaction as StringSelectMenuInteraction)
        } else if (id === 'sudo:action') {
          const { handleSudoPanelSelect } = await import('../../interactions/selects/sudoPanel')
          await handleSudoPanelSelect(interaction as StringSelectMenuInteraction)
        } else if (id === 'sudo:force_owner:channel_pick') {
          const { handleForceOwnerChannelPick } = await import('../../interactions/forceOwnerTransfer')
          await handleForceOwnerChannelPick(interaction as StringSelectMenuInteraction)
        } else if (id === 'help:section') {
          const { handleHelpPanelSelect } = await import('../../interactions/selects/helpPanel')
          await handleHelpPanelSelect(interaction as StringSelectMenuInteraction)
        } else if (id.startsWith('staff:dept_pick:')) {
          const { handleStaffDeptPickSelect } = await import('../../commands/staff')
          await handleStaffDeptPickSelect(interaction as StringSelectMenuInteraction)
        } else if (id.startsWith('staff:tier_pick:')) {
          const { handleStaffTierPickSelect } = await import('../../commands/staff')
          await handleStaffTierPickSelect(interaction as StringSelectMenuInteraction)
        } else if (id === 'staff:role_pick') {
          // Legacy single-pick select — older messages still in flight.
          const { handleStaffRolePickSelect } = await import('../../commands/staff')
          await handleStaffRolePickSelect(interaction as StringSelectMenuInteraction)
        } else if (id.startsWith('sudo:set:') && !id.startsWith('sudo:set:save:')) {
          // All Settings string-selects funnel through one handler. We
          // intentionally exclude `sudo:set:save:*` (those are modal submits
          // with the same prefix — handled in the modal branch below).
          const { handleSettingsStringSelect } = await import('../../interactions/sudoSettings')
          await handleSettingsStringSelect(interaction as StringSelectMenuInteraction)
        } else if (id === 'games:cat:select') {
          const { handleCatalogStringSelect } = await import('../../interactions/gamesEditor')
          await handleCatalogStringSelect(interaction as StringSelectMenuInteraction)
        } else if (id.startsWith('games:prefs:pick:')) {
          const { handlePrefsPick } = await import('../../interactions/gamesEditor')
          await handlePrefsPick(interaction as StringSelectMenuInteraction)
        } else if (id === 'games:bulk:select') {
          const { handleGameDefaultsSelect } = await import('../../interactions/gamesEditor')
          await handleGameDefaultsSelect(interaction as StringSelectMenuInteraction)
        } else if (id.startsWith('games:mass:view:') || id.startsWith('games:mass:ping:')) {
          const { handleMassSelect } = await import('../../interactions/gamesEditor')
          await handleMassSelect(interaction as StringSelectMenuInteraction)
        } else if (id === 'color:pick') {
          const { handleColorPick } = await import('../../commands/color')
          await handleColorPick(interaction as StringSelectMenuInteraction)
        }

      } else if (interaction.isModalSubmit()) {
        const id = interaction.customId
        if (isVcCustomId(id)) {
          const { handleVoiceRenameModal } = await import('../../interactions/modals/voiceRename')
          await handleVoiceRenameModal(interaction as ModalSubmitInteraction)
        } else if (id.startsWith('staff:request:')) {
          const { handleStaffRequestModal } = await import('../../interactions/modals/staffRequest')
          await handleStaffRequestModal(interaction as ModalSubmitInteraction)
        } else if (id === 'report:submit') {
          const { handleReportSubmit } = await import('../../interactions/modals/reportSubmit')
          await handleReportSubmit(interaction as ModalSubmitInteraction)
        } else if (id.startsWith('sudo:set:')) {
          // All Settings modal submits funnel through one handler:
          //   sudo:set:save:{key}                           — numeric setting modal
          //   sudo:set:social:add_submit                    — social feed add
          //   sudo:set:hub:defaults_submit:{channelId}      — per-hub defaults
          //   sudo:set:hub_lockdown:lock_one_submit:{cid}   — per-hub lockdown
          const { handleSettingsModalSubmit } = await import('../../interactions/sudoSettings')
          await handleSettingsModalSubmit(interaction as ModalSubmitInteraction)
        } else if (id.startsWith('profile:save:')) {
          const { handleProfileModal } = await import('../../interactions/profileEditor')
          await handleProfileModal(interaction as ModalSubmitInteraction)
        } else if (id === 'games:cat:add_submit' || id.startsWith('games:cat:save:')) {
          const { handleCatalogModal } = await import('../../interactions/gamesEditor')
          await handleCatalogModal(interaction as ModalSubmitInteraction)
        } else if (id.startsWith('gn:setup_submit')) {
          const { handleSetupSubmit } = await import('../../commands/gamenight')
          await handleSetupSubmit(interaction as ModalSubmitInteraction)
        }
      }
    } catch (err) {
      // Structured context — without `tag`, `cmd`, `customId` etc. tracing
      // an "Interaction error" entry to a specific button/command meant
      // grepping the customId out of stack frames. With this we get one log
      // line per failure that's directly diagnosable.
      const tag = interaction.isChatInputCommand() ? `cmd=${interaction.commandName}`
        : interaction.isContextMenuCommand() ? `ctx=${interaction.commandName}`
        : interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()
          ? `id=${interaction.customId}`
          : `type=${interaction.type}`
      const userTag = `user=${interaction.user.id}`
      const guildTag = interaction.guildId ? `guild=${interaction.guildId}` : 'guild=dm'
      console.error(`Interaction error: ${tag} ${userTag} ${guildTag}`, err)
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
