import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
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
import { DEPARTMENT_DEFS, TIER_DEFS, findDepartmentBySlug, findTierBySlug } from '../services/staffRoles'

// State token used in customIds when no slug has been picked yet for a
// particular axis. `[a-z0-9_]+` to stay within the slug pattern so the
// same validator works everywhere.
const NONE = 'none'

function slugOrNone(v: string | null | undefined): string {
  return v && v.length > 0 ? v : NONE
}

function noneToNull(v: string): string | null {
  return v === NONE ? null : v
}

/**
 * Build the ephemeral request-picker message body. Two selects (department,
 * tier) and a Submit button. Each select's default option reflects the
 * current state, and the Submit button's customId encodes both selections
 * so its handler doesn't need to read the message back.
 */
function renderPickerComponents(deptSlug: string | null, tierSlug: string | null) {
  const headerLines = ['## 📝 Request a Staff Role']
  const detailLines = [
    'Pick a department, a tier, or both. At least one is required.',
    '',
    "After you submit, we'll ask for an optional real / preferred name.",
    'Approving sudo will also grant the **IT CRI Staff** base role automatically.',
  ]

  const deptSelect = new StringSelectMenuBuilder()
    .setCustomId(`staff:dept_pick:${slugOrNone(tierSlug)}`)
    .setPlaceholder(
      deptSlug
        ? `Department: ${findDepartmentBySlug(deptSlug)?.label ?? deptSlug}`
        : 'Pick a department (optional)…',
    )
    .addOptions(
      // First option: clear the selection. Then the 5 departments.
      [
        { label: '— No department —', value: NONE, default: deptSlug === null },
        ...DEPARTMENT_DEFS.map((d) => ({
          label: d.label,
          value: d.slug,
          default: deptSlug === d.slug,
        })),
      ],
    )

  const tierSelect = new StringSelectMenuBuilder()
    .setCustomId(`staff:tier_pick:${slugOrNone(deptSlug)}`)
    .setPlaceholder(
      tierSlug ? `Tier: ${findTierBySlug(tierSlug)?.label ?? tierSlug}` : 'Pick a tier (optional)…',
    )
    .addOptions([
      { label: '— No tier —', value: NONE, default: tierSlug === null },
      ...TIER_DEFS.map((d) => ({
        label: d.label,
        value: d.slug,
        default: tierSlug === d.slug,
      })),
    ])

  const submitDisabled = deptSlug === null && tierSlug === null
  const submitButton = new ButtonBuilder()
    .setCustomId(`staff:request_open:${slugOrNone(deptSlug)}:${slugOrNone(tierSlug)}`)
    .setLabel(submitDisabled ? 'Pick at least one' : 'Continue →')
    .setStyle(submitDisabled ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setDisabled(submitDisabled)

  const container = new ContainerBuilder()
    .setAccentColor(0x57f287)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(detailLines.join('\n')))

  const deptRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(deptSelect)
  const tierRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(tierSelect)
  const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    submitButton,
  )

  return { container, deptRow, tierRow, buttonRow }
}

/**
 * Step 1 — entry point. Opens the ephemeral picker.
 */
export async function showStaffRolePicker(interaction: ButtonInteraction): Promise<void> {
  const { container, deptRow, tierRow, buttonRow } = renderPickerComponents(null, null)
  await interaction.reply({
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container, deptRow, tierRow, buttonRow],
  } as any)
}

/**
 * Step 2a — user picked a department. Re-render the message with the
 * department locked in and the tier select unchanged. The OTHER axis's
 * slug rides in the customId so we don't lose it across the round trip.
 */
export async function handleStaffDeptPickSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const parts = interaction.customId.split(':')
  // staff:dept_pick:{tier_so_far}
  const tierSoFar = noneToNull(parts[2] ?? NONE)
  const picked = interaction.values[0]
  const deptSlug = picked === NONE ? null : picked

  if (deptSlug !== null && !findDepartmentBySlug(deptSlug)) {
    await interaction.reply({ content: `❌ Unknown department: \`${deptSlug}\``, ephemeral: true })
    return
  }

  const { container, deptRow, tierRow, buttonRow } = renderPickerComponents(deptSlug, tierSoFar)
  await interaction.update({
    flags: MessageFlags.IsComponentsV2,
    components: [container, deptRow, tierRow, buttonRow],
  } as any)
}

/**
 * Step 2b — user picked a tier. Symmetric to the department handler.
 */
export async function handleStaffTierPickSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const parts = interaction.customId.split(':')
  // staff:tier_pick:{dept_so_far}
  const deptSoFar = noneToNull(parts[2] ?? NONE)
  const picked = interaction.values[0]
  const tierSlug = picked === NONE ? null : picked

  if (tierSlug !== null && !findTierBySlug(tierSlug)) {
    await interaction.reply({ content: `❌ Unknown tier: \`${tierSlug}\``, ephemeral: true })
    return
  }

  const { container, deptRow, tierRow, buttonRow } = renderPickerComponents(deptSoFar, tierSlug)
  await interaction.update({
    flags: MessageFlags.IsComponentsV2,
    components: [container, deptRow, tierRow, buttonRow],
  } as any)
}

/**
 * Step 3 — Submit clicked. Opens a one-field modal for the optional real
 * name. Both slugs ride in the modal customId so the modal-submit handler
 * can resolve them back to keys.
 */
export async function handleStaffRequestOpenButton(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(':')
  // staff:request_open:{dept_or_none}:{tier_or_none}
  const deptSlug = noneToNull(parts[2] ?? NONE)
  const tierSlug = noneToNull(parts[3] ?? NONE)

  if (deptSlug === null && tierSlug === null) {
    await interaction.reply({
      content: '❌ Pick a department or a tier first.',
      ephemeral: true,
    })
    return
  }

  const titleParts: string[] = []
  if (deptSlug) titleParts.push(findDepartmentBySlug(deptSlug)?.label ?? deptSlug)
  if (tierSlug) titleParts.push(findTierBySlug(tierSlug)?.label ?? tierSlug)
  const title = `Request: ${titleParts.join(' · ')}`.slice(0, 45)

  const modal = new ModalBuilder()
    .setCustomId(`staff:request:${slugOrNone(deptSlug)}:${slugOrNone(tierSlug)}`)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('real_name')
          .setLabel('Real / preferred name (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(64),
      ),
    )

  await interaction.showModal(modal)
}

/**
 * Back-compat shim — older callers imported `showStaffRequestModal`.
 */
export const showStaffRequestModal = showStaffRolePicker

/**
 * Back-compat shim for the legacy single-role select. The select still
 * registers as `staff:role_pick` in older messages; route it to the new
 * two-select flow by re-opening the picker so the user can pick again.
 */
export async function handleStaffRolePickSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  await interaction.reply({
    content:
      'The staff request flow changed — pick from the updated form below (open `/settings → Staff Role` again to start fresh).',
    ephemeral: true,
  })
}
