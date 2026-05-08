/**
 * `/settings → Staff Role` — self-service Discord-staff-role management.
 *
 * Behavior is gated by sudo:
 *   • Sudo can grant or remove ANY of the 7 staff roles on themselves
 *     directly. They already have authority, so the request/approval gate
 *     would just be ceremony for them.
 *   • Non-sudo can REMOVE staff roles they currently hold (always safe —
 *     no privilege escalation possible). To ADD a role they don't have,
 *     they're routed to the existing request flow (`open_staff_request`).
 *
 * Per-role status renders one of:
 *   ✅ holds + linked     → "Remove" button (everyone)
 *   ⚠️ holds + role gone  → DB role id no longer resolves; nothing to do
 *   ➕ doesn't hold       → "Grant" (sudo) or "Request" (non-sudo)
 *   🚫 not linked yet     → bot_settings key empty; sudo provisions in
 *                            /sudo → Settings → Staff Roles first
 *
 * customId families:
 *   settings:staff_role                        button on /settings home
 *   settings:staff_role:back                   back to /settings home
 *   settings:staff_role:add:{slug}             button — sudo grant on self
 *   settings:staff_role:remove:{slug}          button — anyone remove from self
 */
import {
  type ButtonInteraction,
  type GuildMember,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js'
import { sep } from '../utils/cv2'
import { isSudo } from '../services/voice/permissions'
import { getSetting } from '../services/settings'
import { STAFF_ROLE_DEFS, findStaffRoleDefBySlug } from '../services/staffRoles'
import { logger } from '../services/logger'

interface SlotState {
  slug: string
  label: string
  has: boolean
  /** `bot_settings` linked role id, or null if no linked id is set. */
  linkedId: string | null
  /** True when the linked id exists in `bot_settings` AND the Discord role still exists. */
  linkedRoleExists: boolean
}

function snapshotSlots(member: GuildMember): SlotState[] {
  return STAFF_ROLE_DEFS.map(def => {
    const linkedId = getSetting(def.key)
    const role = linkedId ? member.guild.roles.cache.get(linkedId) ?? null : null
    return {
      slug: def.slug,
      label: def.label,
      has: !!linkedId && member.roles.cache.has(linkedId),
      linkedId,
      linkedRoleExists: !!role,
    }
  })
}

export function renderStaffRoleSelf(member: GuildMember) {
  const sudo = isSudo(member)
  const slots = snapshotSlots(member)

  const lines: string[] = []
  lines.push('### 🛡️ Staff Role')
  if (sudo) {
    lines.push('_You\'re sudo — you can grant or remove any staff role on yourself directly._')
  } else {
    lines.push('_Remove any staff role you currently hold. To **add** a role, click **Request a Staff Role** below — an admin reviews it._')
  }
  lines.push('')
  for (const s of slots) {
    let marker: string
    if (s.has) marker = '✅'
    else if (!s.linkedId) marker = '🚫'
    else if (!s.linkedRoleExists) marker = '⚠️'
    else marker = '➕'
    const note =
      !s.linkedId            ? ' _(not linked — sudo provisions in /sudo → Settings → Staff Roles)_'
      : !s.linkedRoleExists  ? ' _(linked id no longer exists in Discord)_'
      : s.has                ? ' _(you hold this)_'
      :                        ''
    lines.push(`${marker} **${s.label}**${note}`)
  }

  const container = new ContainerBuilder()
    .setAccentColor(sudo ? 0x5865f2 : 0xfee75c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addSeparatorComponents(sep())

  const components: any[] = [container]

  // Build action rows. Discord allows up to 5 rows of ≤5 buttons each. With
  // 7 slots we can fit 4 then 3, plus a nav row.
  const buttons: ButtonBuilder[] = []
  for (const s of slots) {
    if (s.has) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`settings:staff_role:remove:${s.slug}`)
          .setLabel(`Remove ${s.label}`)
          .setEmoji('➖')
          .setStyle(ButtonStyle.Danger)
      )
    } else if (sudo && s.linkedRoleExists) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`settings:staff_role:add:${s.slug}`)
          .setLabel(`Grant ${s.label}`)
          .setEmoji('➕')
          .setStyle(ButtonStyle.Success)
      )
    }
    // else: non-sudo who doesn't hold it — handled by the Request button below.
  }
  for (let i = 0; i < buttons.length; i += 5) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(buttons.slice(i, i + 5))
    )
  }

  const navButtons: ButtonBuilder[] = []
  if (!sudo) {
    navButtons.push(
      new ButtonBuilder()
        .setCustomId('open_staff_request')
        .setLabel('Request a Staff Role')
        .setEmoji('📝')
        .setStyle(ButtonStyle.Primary)
    )
  }
  navButtons.push(
    new ButtonBuilder()
      .setCustomId('settings:home')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  )
  components.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(navButtons))

  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

/** `settings:staff_role` — open the panel from /settings home. */
export async function handleStaffRoleSelfButton(interaction: ButtonInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  await interaction.update(renderStaffRoleSelf(member) as any)
}

/** `settings:staff_role:add:{slug}` — sudo-only grant on self. */
export async function handleStaffRoleSelfAdd(interaction: ButtonInteraction): Promise<void> {
  const slug = interaction.customId.slice('settings:staff_role:add:'.length)
  const def = findStaffRoleDefBySlug(slug)
  if (!def) {
    await interaction.reply({ content: `❌ Unknown staff role: \`${slug}\``, ephemeral: true })
    return
  }
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  if (!isSudo(member)) {
    await interaction.reply({
      content: '❌ Only sudo can grant a staff role to themselves directly. Use **Request a Staff Role** for the approval flow.',
      ephemeral: true,
    })
    return
  }
  const roleId = getSetting(def.key)
  if (!roleId) {
    await interaction.reply({ content: `❌ **${def.label}** is not linked yet. Provision in /sudo → Settings → Staff Roles first.`, ephemeral: true })
    return
  }
  const role = member.guild.roles.cache.get(roleId) ?? await member.guild.roles.fetch(roleId).catch(() => null)
  if (!role) {
    await interaction.reply({ content: `❌ Linked role for **${def.label}** (id \`${roleId}\`) no longer exists in Discord.`, ephemeral: true })
    return
  }
  if (member.roles.cache.has(role.id)) {
    await interaction.update(renderStaffRoleSelf(member) as any)
    return
  }
  try {
    await member.roles.add(role, `self-grant via /settings (sudo: ${interaction.user.tag})`)
    logger.info(`Self-granted ${def.label} to sudo ${interaction.user.tag}`)
  } catch (err) {
    await interaction.reply({ content: `❌ Failed to grant **${def.label}**: ${(err as Error).message}`, ephemeral: true })
    return
  }
  // Re-fetch with cache invalidation so the snapshot reflects the new role.
  const refreshed = await member.guild.members.fetch({ user: member.id, force: true }).catch(() => member)
  await interaction.update(renderStaffRoleSelf(refreshed) as any)
}

/** `settings:staff_role:remove:{slug}` — anyone removes a role from themselves. */
export async function handleStaffRoleSelfRemove(interaction: ButtonInteraction): Promise<void> {
  const slug = interaction.customId.slice('settings:staff_role:remove:'.length)
  const def = findStaffRoleDefBySlug(slug)
  if (!def) {
    await interaction.reply({ content: `❌ Unknown staff role: \`${slug}\``, ephemeral: true })
    return
  }
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const roleId = getSetting(def.key)
  if (!roleId || !member.roles.cache.has(roleId)) {
    // Already gone — just re-render.
    await interaction.update(renderStaffRoleSelf(member) as any)
    return
  }
  try {
    await member.roles.remove(roleId, `self-remove via /settings (${interaction.user.tag})`)
    logger.info(`Self-removed ${def.label} from ${interaction.user.tag}`)
  } catch (err) {
    await interaction.reply({ content: `❌ Failed to remove **${def.label}**: ${(err as Error).message}`, ephemeral: true })
    return
  }
  const refreshed = await member.guild.members.fetch({ user: member.id, force: true }).catch(() => member)
  await interaction.update(renderStaffRoleSelf(refreshed) as any)
}
