/**
 * Shared profile editor — used from three entry points:
 *   1. /sudo → Settings → User Profiles  (mode='sudo', user picked via UserSelectMenu)
 *   2. Right-click → Manage User → Edit Profile  (mode='sudo', target pre-set)
 *   3. /profile  (mode='self', target = caller, restricted field set)
 *
 * customId scheme — colon-separated:
 *   profile:select_user                   user-select  → sudo entry, pick target
 *   profile:edit:{mode}:{uid}:{field}     button       → open modal for a text field
 *   profile:save:{mode}:{uid}:{field}     modal submit → persist text-field value(s)
 *   profile:toggle:{mode}:{uid}:{field}   button       → flip a boolean field
 *   profile:back:{mode}:{uid}             button       → back to entry/dismiss
 *
 * `mode` is 'sudo' or 'self'. `uid` is the target Discord user ID.
 * `field` matches a column on user_profiles (camelCase as in TS schema).
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  ContainerBuilder, MessageFlags, ModalBuilder, TextDisplayBuilder,
  TextInputBuilder, TextInputStyle, UserSelectMenuBuilder,
  type ButtonInteraction, type ChatInputCommandInteraction,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction, type StringSelectMenuInteraction,
  type UserContextMenuCommandInteraction, type UserSelectMenuInteraction,
} from 'discord.js'
import { sep } from '../utils/cv2'
import { isSudo } from '../services/voice/permissions'
import {
  countProfiles, ensureProfile, formatBirthday, getProfile, isSelfEditable,
  updateProfile, type SudoEditableField, type UserProfile,
} from '../services/userProfile'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProfileMode = 'sudo' | 'self'

interface FieldDef {
  field: SudoEditableField
  label: string
  hint: string
  /** Modal input style. Booleans use toggle buttons instead. */
  kind: 'text' | 'short-text' | 'integer' | 'boolean'
  /** Self-mode visibility — sudo always sees everything. */
  selfVisible: boolean
}

const FIELDS: FieldDef[] = [
  { field: 'displayName',        label: 'Display name',     hint: 'How the bot refers to you',   kind: 'short-text', selfVisible: true },
  { field: 'realName',           label: 'Real name',        hint: 'Sudo only',                   kind: 'short-text', selfVisible: false },
  { field: 'birthdayMonth',      label: 'Birthday month',   hint: '1–12',                        kind: 'integer',    selfVisible: true },
  { field: 'birthdayDay',        label: 'Birthday day',     hint: '1–31',                        kind: 'integer',    selfVisible: true },
  { field: 'birthdayPingsEnabled', label: 'Birthday pings', hint: 'Receive ping on your birthday', kind: 'boolean',  selfVisible: true },
  { field: 'birthdayYearVisible', label: 'Show year',       hint: 'Currently no year stored — reserved for future use', kind: 'boolean', selfVisible: true },
  { field: 'staffCategory',      label: 'Staff category',   hint: 'Sudo only',                   kind: 'short-text', selfVisible: false },
  { field: 'department',         label: 'Department',       hint: 'Sudo only',                   kind: 'short-text', selfVisible: false },
  { field: 'tier',               label: 'Tier',             hint: 'Sudo only',                   kind: 'short-text', selfVisible: false },
  { field: 'leadershipTitle',    label: 'Leadership title', hint: 'Sudo only',                   kind: 'short-text', selfVisible: false },
]

function fieldDef(field: string): FieldDef | null {
  return FIELDS.find(f => f.field === field) ?? null
}

function valueDisplay(p: UserProfile | null, def: FieldDef): string {
  if (!p) return '_unset_'
  const raw = (p as any)[def.field]
  if (def.kind === 'boolean') return raw ? '🟢 enabled' : '🔴 disabled'
  if (def.field === 'birthdayMonth' || def.field === 'birthdayDay') return formatBirthday(p)  // shown once on the Birthday row
  if (raw === null || raw === undefined || raw === '') return '_unset_'
  return `\`${String(raw)}\``
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** Sudo entry point — UserSelectMenu to pick a target. */
export async function renderSudoUserPicker(guildId: string) {
  const total = await countProfiles(guildId)
  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      '### 👤 User Profiles\n' +
      `_${total} profile(s) on file._\n\n` +
      'Pick a member to view or edit their bot profile (display name, birthday, staff fields, opt-outs):'
    ))

  const userPick = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('profile:select_user')
      .setPlaceholder('Pick a member…')
      .setMinValues(1).setMaxValues(1)
  )

  const back = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary)
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components: [container, userPick, back] }
}

export async function renderProfileEditor(
  guildId: string,
  targetUserId: string,
  targetDisplayName: string,
  mode: ProfileMode,
) {
  const profile = await ensureProfile(guildId, targetUserId)

  const visibleFields = mode === 'sudo' ? FIELDS : FIELDS.filter(f => f.selfVisible)

  // Group: Personal | Staff (sudo only) | Toggles
  const personalFields = visibleFields.filter(f => ['displayName', 'realName'].includes(f.field))
  const birthdayFields = visibleFields.filter(f => ['birthdayMonth', 'birthdayDay'].includes(f.field))
  const staffFields    = visibleFields.filter(f => ['staffCategory', 'department', 'tier', 'leadershipTitle'].includes(f.field))
  const toggleFields   = visibleFields.filter(f => f.kind === 'boolean')

  const lines: string[] = []
  lines.push(`### 👤 Profile — ${targetDisplayName}`)
  lines.push(mode === 'sudo' ? '_Sudo edit. Changes are logged._' : '_Self-service. Only you can see this view._')
  lines.push('')

  if (personalFields.length) {
    lines.push('**Personal**')
    for (const f of personalFields) {
      lines.push(`• **${f.label}** — ${valueDisplay(profile, f)}`)
    }
    lines.push('')
  }
  if (birthdayFields.length) {
    lines.push('**Birthday**')
    lines.push(`• **Date** — ${formatBirthday(profile)}`)
    for (const f of toggleFields) {
      lines.push(`• **${f.label}** — ${valueDisplay(profile, f)}`)
    }
    lines.push('')
  }
  if (staffFields.length) {
    lines.push('**Staff** _(sudo only)_')
    for (const f of staffFields) {
      lines.push(`• **${f.label}** — ${valueDisplay(profile, f)}`)
    }
  }

  const container = new ContainerBuilder()
    .setAccentColor(mode === 'sudo' ? 0xed4245 : 0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]

  // Personal row — Display Name, optional Real Name, Birthday combo modal
  const personalRow = new ActionRowBuilder<MessageActionRowComponentBuilder>()
  personalRow.addComponents(
    new ButtonBuilder().setCustomId(`profile:edit:${mode}:${targetUserId}:displayName`)
      .setLabel('Display Name').setEmoji('✏️').setStyle(ButtonStyle.Primary),
  )
  if (mode === 'sudo') {
    personalRow.addComponents(
      new ButtonBuilder().setCustomId(`profile:edit:${mode}:${targetUserId}:realName`)
        .setLabel('Real Name').setEmoji('🪪').setStyle(ButtonStyle.Primary),
    )
  }
  personalRow.addComponents(
    new ButtonBuilder().setCustomId(`profile:edit:${mode}:${targetUserId}:birthday`)
      .setLabel('Birthday').setEmoji('🎂').setStyle(ButtonStyle.Primary),
  )
  components.push(personalRow)

  // Toggles row
  const toggleRow = new ActionRowBuilder<MessageActionRowComponentBuilder>()
  for (const f of toggleFields) {
    const enabled = (profile as any)[f.field] === true
    toggleRow.addComponents(
      new ButtonBuilder().setCustomId(`profile:toggle:${mode}:${targetUserId}:${f.field}`)
        .setLabel(`${enabled ? 'Disable' : 'Enable'} — ${f.label}`)
        .setEmoji(enabled ? '🔴' : '🟢')
        .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    )
  }
  if (toggleRow.components.length) components.push(toggleRow)

  // Staff fields (sudo only)
  if (staffFields.length) {
    const staffRow = new ActionRowBuilder<MessageActionRowComponentBuilder>()
    for (const f of staffFields) {
      staffRow.addComponents(
        new ButtonBuilder().setCustomId(`profile:edit:${mode}:${targetUserId}:${f.field}`)
          .setLabel(f.label).setEmoji('🏢').setStyle(ButtonStyle.Secondary),
      )
    }
    components.push(staffRow)
  }

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`profile:back:${mode}:${targetUserId}`).setLabel('Back').setStyle(ButtonStyle.Secondary),
    )
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function buildModal(mode: ProfileMode, userId: string, field: string, currentValue: string): ModalBuilder {
  if (field === 'birthday') {
    return new ModalBuilder()
      .setCustomId(`profile:save:${mode}:${userId}:birthday`)
      .setTitle('Edit birthday')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('month').setLabel('Month (1–12)')
            .setStyle(TextInputStyle.Short).setRequired(false).setValue(currentValue.split('/')[0] ?? '')
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('day').setLabel('Day (1–31)')
            .setStyle(TextInputStyle.Short).setRequired(false).setValue(currentValue.split('/')[1] ?? '')
        ),
      )
  }

  const def = fieldDef(field)
  if (!def) throw new Error(`Unknown field: ${field}`)

  return new ModalBuilder()
    .setCustomId(`profile:save:${mode}:${userId}:${field}`)
    .setTitle(`Edit ${def.label}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('value').setLabel(def.label)
          .setStyle(def.kind === 'integer' ? TextInputStyle.Short : TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder(def.hint)
          .setValue(currentValue)
      )
    )
}

// ---------------------------------------------------------------------------
// Permission helper — sudo edits anyone, self edits self.
// ---------------------------------------------------------------------------

async function authorize(
  interaction: ButtonInteraction | UserSelectMenuInteraction | ModalSubmitInteraction,
  mode: ProfileMode,
  targetUserId: string,
): Promise<boolean> {
  if (!interaction.guild) return false
  const member = await interaction.guild.members.fetch(interaction.user.id)
  if (mode === 'sudo') {
    if (!isSudo(member)) {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Sudo access required.', ephemeral: true })
      }
      return false
    }
    return true
  }
  // mode === 'self'
  if (targetUserId !== interaction.user.id) {
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ You can only edit your own profile.', ephemeral: true })
    }
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Handlers — wired from interactionCreate.ts via id.startsWith('profile:')
// ---------------------------------------------------------------------------

/** profile:select_user — sudo picks who to edit. */
export async function handleProfileUserSelect(interaction: UserSelectMenuInteraction): Promise<void> {
  if (!await authorize(interaction, 'sudo', '*')) return
  const userId = interaction.values[0]
  if (!userId || !interaction.guild) {
    await interaction.update(await renderSudoUserPicker(interaction.guildId!) as any)
    return
  }
  const member = await interaction.guild.members.fetch(userId).catch(() => null)
  const name = member?.displayName ?? `<@${userId}>`
  await interaction.update(await renderProfileEditor(interaction.guildId!, userId, name, 'sudo') as any)
}

/** profile:edit:{mode}:{uid}:{field} — show a modal for a text field. */
export async function handleProfileEditButton(interaction: ButtonInteraction): Promise<void> {
  const [, , mode, userId, field] = interaction.customId.split(':')
  if (!await authorize(interaction, mode as ProfileMode, userId)) return

  const profile = await getProfile(interaction.guildId!, userId)
  let currentValue = ''
  if (field === 'birthday') {
    currentValue = `${profile?.birthdayMonth ?? ''}/${profile?.birthdayDay ?? ''}`
  } else {
    const v = (profile as any)?.[field]
    currentValue = v == null ? '' : String(v)
  }
  const modal = buildModal(mode as ProfileMode, userId, field, currentValue)
  await interaction.showModal(modal)
}

/** profile:toggle:{mode}:{uid}:{field} — flip a boolean. */
export async function handleProfileToggle(interaction: ButtonInteraction): Promise<void> {
  const [, , mode, userId, field] = interaction.customId.split(':')
  if (!await authorize(interaction, mode as ProfileMode, userId)) return

  if (mode === 'self' && !isSelfEditable(field)) {
    await interaction.reply({ content: `❌ "${field}" is not self-editable.`, ephemeral: true })
    return
  }

  const profile = await getProfile(interaction.guildId!, userId)
  const current = (profile as any)?.[field] === true
  await updateProfile(interaction.guildId!, userId, { [field]: !current } as any, {
    editorDiscordId: interaction.user.id, mode: mode as ProfileMode,
  })

  const member = await interaction.guild!.members.fetch(userId).catch(() => null)
  const name = member?.displayName ?? `<@${userId}>`
  await interaction.update(await renderProfileEditor(interaction.guildId!, userId, name, mode as ProfileMode) as any)
}

/** profile:save:{mode}:{uid}:{field} — modal submit handler. */
export async function handleProfileModal(interaction: ModalSubmitInteraction): Promise<void> {
  const [, , mode, userId, field] = interaction.customId.split(':')
  if (!await authorize(interaction, mode as ProfileMode, userId)) return

  const patch: Partial<Record<SudoEditableField, any>> = {}

  if (field === 'birthday') {
    const monthRaw = interaction.fields.getTextInputValue('month').trim()
    const dayRaw = interaction.fields.getTextInputValue('day').trim()
    if (monthRaw === '' && dayRaw === '') {
      patch.birthdayMonth = null
      patch.birthdayDay = null
    } else {
      const m = Number(monthRaw)
      const d = Number(dayRaw)
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        await interaction.reply({ content: `❌ Month must be 1–12 (got \`${monthRaw}\`).`, ephemeral: true })
        return
      }
      const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
      if (!Number.isInteger(d) || d < 1 || d > daysInMonth[m - 1]) {
        await interaction.reply({ content: `❌ Day must be 1–${daysInMonth[m - 1]} for that month.`, ephemeral: true })
        return
      }
      patch.birthdayMonth = m
      patch.birthdayDay = d
    }
  } else {
    const def = fieldDef(field)
    if (!def) {
      await interaction.reply({ content: `❌ Unknown field: \`${field}\``, ephemeral: true })
      return
    }
    if (mode === 'self' && !isSelfEditable(field)) {
      await interaction.reply({ content: `❌ "${field}" is not self-editable.`, ephemeral: true })
      return
    }
    const raw = interaction.fields.getTextInputValue('value').trim()
    if (def.kind === 'integer') {
      if (raw === '') {
        (patch as any)[def.field] = null
      } else {
        const n = Number(raw)
        if (!Number.isInteger(n)) {
          await interaction.reply({ content: `❌ Not an integer: \`${raw}\``, ephemeral: true })
          return
        }
        (patch as any)[def.field] = n
      }
    } else {
      (patch as any)[def.field] = raw === '' ? null : raw
    }
  }

  await updateProfile(interaction.guildId!, userId, patch, {
    editorDiscordId: interaction.user.id, mode: mode as ProfileMode,
  })

  const member = await interaction.guild!.members.fetch(userId).catch(() => null)
  const name = member?.displayName ?? `<@${userId}>`
  if (interaction.isFromMessage()) {
    await interaction.update(await renderProfileEditor(interaction.guildId!, userId, name, mode as ProfileMode) as any)
  } else {
    await interaction.reply({ content: '✅ Profile updated.', ephemeral: true })
  }
}

/** profile:back:{mode}:{uid} */
export async function handleProfileBack(interaction: ButtonInteraction): Promise<void> {
  const [, , mode] = interaction.customId.split(':')
  if (mode === 'sudo') {
    if (!await authorize(interaction, 'sudo', '*')) return
    await interaction.update(await renderSudoUserPicker(interaction.guildId!) as any)
  } else {
    // Self mode — replace the message with a brief acknowledgement.
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [
      new ContainerBuilder().setAccentColor(0x57f287).addTextDisplayComponents(
        new TextDisplayBuilder().setContent('✅ Profile changes saved. You can close this.')
      ),
    ] } as any)
  }
}

/** Public entry — open the editor directly for a known target (Manage User / /profile). */
export async function openProfileEditor(
  interaction: ButtonInteraction | UserContextMenuCommandInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction,
  targetUserId: string,
  targetDisplayName: string,
  mode: ProfileMode,
): Promise<void> {
  const payload = await renderProfileEditor(interaction.guildId!, targetUserId, targetDisplayName, mode)
  if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
    await interaction.reply({ ...payload, ephemeral: true } as any)
  } else {
    await interaction.editReply(payload as any)
  }
}
