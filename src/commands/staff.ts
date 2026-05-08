import {
  ActionRowBuilder,
  ButtonInteraction,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageActionRowComponentBuilder,
} from 'discord.js'
import { sep } from '../utils/cv2'
import { STAFF_ROLE_DEFS, findStaffRoleDefBySlug } from '../services/staffRoles'

/**
 * Step 1 — show an ephemeral picker listing the 7 staff roles.
 *
 * Replaces the legacy free-text Category / Department / Tier modal so requesters
 * pick from a known list instead of typing variations like "HD" / "Help Desk" /
 * "helpdesk" that an approver would otherwise have to interpret.
 */
export async function showStaffRolePicker(interaction: ButtonInteraction): Promise<void> {
  const container = new ContainerBuilder()
    .setAccentColor(0x57f287)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('## 📝 Request a Staff Role')
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        'Pick the staff role you\'re requesting. After you pick, you\'ll get a small form ' +
        'for your real / preferred name and a short reason. Both are optional.'
      )
    )

  const select = new StringSelectMenuBuilder()
    .setCustomId('staff:role_pick')
    .setPlaceholder('Pick a staff role…')
    .addOptions(
      STAFF_ROLE_DEFS.map(def => ({
        label: def.label,
        value: def.slug,
      }))
    )

  const selectRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select)

  await interaction.reply({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container, selectRow],
  } as any)
}

/**
 * Step 2 — when the requester picks a role from the select menu, open a modal
 * that captures only the still-free-form fields (`real_name`, `reason`). The
 * picked role's slug rides in the modal customId so the submit handler can
 * resolve it back to the bot_settings key.
 */
export async function handleStaffRolePickSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const slug = interaction.values[0]
  const def = findStaffRoleDefBySlug(slug)
  if (!def) {
    await interaction.reply({ content: `❌ Unknown staff role: \`${slug}\``, ephemeral: true })
    return
  }

  const modal = new ModalBuilder()
    .setCustomId(`staff:request:${def.slug}`)
    .setTitle(`Request: ${def.label}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('real_name')
          .setLabel('Real / preferred name (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(64)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Why are you requesting this role? (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000)
      ),
    )
  await interaction.showModal(modal)
}

/**
 * Back-compat shim — the help panel and /squishy still call
 * showStaffRequestModal; keep the export pointing at the new picker so legacy
 * imports don't need to change.
 */
export const showStaffRequestModal = showStaffRolePicker
