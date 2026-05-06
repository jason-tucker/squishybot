/**
 * Games editor — two distinct surfaces sharing this module:
 *
 *   1. Catalog editor (sudo only) — define games, link roles/channels, archive/delete.
 *      Entry: /sudo → Settings → Games  (renderCatalog → renderGameDetail).
 *
 *   2. Prefs editor — set view/ping toggles per game on a target user.
 *      Entry: /games (mode='self') OR Manage User → Game Prefs (mode='sudo').
 *      Entry: renderPrefsEditor(guildId, targetUserId, mode).
 *
 * customId families:
 *   games:cat:list                          button — back to catalog list
 *   games:cat:add                           button — show create modal
 *   games:cat:add_submit                    modal  — persist new game
 *   games:cat:select                        string-select — pick a game to edit
 *   games:cat:detail:{gid}                  button — render the editor for one game
 *   games:cat:edit:{gid}:{field}            button — show modal for a text field
 *   games:cat:save:{gid}:{field}            modal  — persist text field
 *   games:cat:role:{gid}:{kind}             role-select — set roleId / pingRoleId
 *   games:cat:channel:{gid}:{kind}          channel-select — set channelId / categoryId
 *   games:cat:toggle:{gid}:{flag}           button — flip isVisible / isArchived
 *   games:cat:delete:{gid}                  button — confirm + delete
 *
 *   games:prefs:toggle:{mode}:{uid}:{gid}:{which}   button
 *   games:prefs:back:{mode}:{uid}                   button
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags,
  ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  TextDisplayBuilder, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type Guild,
  type MessageActionRowComponentBuilder, type ModalSubmitInteraction,
  type RoleSelectMenuInteraction, type StringSelectMenuInteraction,
} from 'discord.js'
import { sep } from '../utils/cv2'
import { requireSudo } from '../services/voice/permissions'
import {
  createGame, deleteGame, gameCount, getGame, listGames, resolvePrefs,
  togglePref, updateGame, type Game,
} from '../services/games'

// ===========================================================================
// CATALOG (sudo only)
// ===========================================================================

export async function renderCatalogList(guildId: string) {
  const all = listGames({ includeArchived: true, includeHidden: true })

  const lines: string[] = ['### 🎮 Games — catalog', `_${gameCount()} game(s)._`, '']
  if (all.length === 0) {
    lines.push('_No games defined yet. Click **Add Game** to start._')
  } else {
    for (const g of all) {
      const flags: string[] = []
      if (!g.isVisible) flags.push('🙈 hidden')
      if (g.isArchived) flags.push('📦 archived')
      const flagStr = flags.length ? ` _(${flags.join(', ')})_` : ''
      const aliasStr = g.aliases.length ? ` _aka ${g.aliases.join(', ')}_` : ''
      lines.push(`• **${g.name}**${aliasStr}${flagStr} · sort \`${g.sortOrder}\``)
    }
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]

  if (all.length > 0) {
    const opts = all.slice(0, 25).map(g => ({
      label: g.name.slice(0, 100),
      value: g.id,
      description: (g.aliases.join(', ') || (g.isArchived ? 'archived' : 'visible')).slice(0, 100),
    }))
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('games:cat:select')
          .setPlaceholder('Pick a game to edit…')
          .addOptions(opts)
      )
    )
  }

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('games:cat:add').setLabel('Add Game').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary),
    )
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

function renderGameDetail(g: Game) {
  const lines: string[] = []
  lines.push(`### 🎮 ${g.name}`)
  if (g.aliases.length) lines.push(`_aka ${g.aliases.join(', ')}_`)
  lines.push('')
  lines.push(`**View role** — ${g.roleId ? `<@&${g.roleId}>` : '_unset_'}`)
  lines.push(`**Ping role** — ${g.pingRoleId ? `<@&${g.pingRoleId}>` : '_unset_'}`)
  lines.push(`**Channel**   — ${g.channelId ? `<#${g.channelId}>` : '_unset_'}`)
  lines.push(`**Category**  — ${g.categoryId ? `<#${g.categoryId}>` : '_unset_'}`)
  lines.push(`**Sort order** — \`${g.sortOrder}\``)
  lines.push(`**Visible** — ${g.isVisible ? '🟢 yes' : '🔴 hidden'}`)
  lines.push(`**Archived** — ${g.isArchived ? '📦 yes' : '🟢 no'}`)

  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]

  // Row 1: text-field edit buttons
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`games:cat:edit:${g.id}:name`).setLabel('Name').setEmoji('✏️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`games:cat:edit:${g.id}:aliases`).setLabel('Aliases').setEmoji('🔤').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`games:cat:edit:${g.id}:sortOrder`).setLabel('Sort').setEmoji('🔢').setStyle(ButtonStyle.Primary),
    )
  )

  const viewSelect = new RoleSelectMenuBuilder()
    .setCustomId(`games:cat:role:${g.id}:view`)
    .setPlaceholder('View role (assigned when wantsView=true)')
    .setMinValues(0).setMaxValues(1)
  if (g.roleId) viewSelect.addDefaultRoles(g.roleId)
  components.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(viewSelect))

  const pingSelect = new RoleSelectMenuBuilder()
    .setCustomId(`games:cat:role:${g.id}:ping`)
    .setPlaceholder('Ping role (assigned when wantsPing=true)')
    .setMinValues(0).setMaxValues(1)
  if (g.pingRoleId) pingSelect.addDefaultRoles(g.pingRoleId)
  components.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(pingSelect))

  // Toggles + delete + back row
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`games:cat:toggle:${g.id}:isVisible`)
        .setLabel(g.isVisible ? 'Hide' : 'Show')
        .setEmoji(g.isVisible ? '🙈' : '👁️')
        .setStyle(g.isVisible ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`games:cat:toggle:${g.id}:isArchived`)
        .setLabel(g.isArchived ? 'Unarchive' : 'Archive')
        .setEmoji('📦')
        .setStyle(g.isArchived ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`games:cat:delete:${g.id}`)
        .setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('games:cat:list')
        .setLabel('Back to list').setStyle(ButtonStyle.Secondary),
    )
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

// ===========================================================================
// PREFS (self + sudo)
// ===========================================================================

export type PrefsMode = 'self' | 'sudo'

export async function renderPrefsEditor(guild: Guild, targetUserId: string, mode: PrefsMode) {
  const member = await guild.members.fetch(targetUserId).catch(() => null)
  const targetName = member?.displayName ?? `<@${targetUserId}>`
  const prefs = await resolvePrefs(guild.id, targetUserId)

  const lines: string[] = [`### 🎮 Game Prefs — ${targetName}`]
  if (mode === 'sudo') lines.push('_Sudo edit. Toggles apply roles on the target._')
  else lines.push('_Pick a game to toggle View access and LFG pings._')
  lines.push('')

  if (prefs.length === 0) {
    lines.push('_No games defined yet. Ask sudo to set up the catalog at `/sudo → Settings → Games`._')
  } else {
    lines.push('| Game | View | Pings |')
    lines.push('|---|---|---|')
    for (const p of prefs) {
      lines.push(`| **${p.game.name}** | ${p.wantsView ? '🟢' : '⚪'} | ${p.wantsPing ? '🔔' : '⚪'} |`)
    }
  }

  const container = new ContainerBuilder()
    .setAccentColor(mode === 'sudo' ? 0xed4245 : 0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]

  // 4-row cap: each game row holds (label, view-toggle, ping-toggle) = 3 buttons,
  // and Discord allows 5 action rows per V2 message minus the Container and the Done row.
  const visiblePrefs = prefs.slice(0, 4)
  for (const p of visiblePrefs) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`games:prefs:noop:${p.game.id}`)
          .setLabel(p.game.name.slice(0, 80))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`games:prefs:toggle:${mode}:${targetUserId}:${p.game.id}:view`)
          .setLabel(p.wantsView ? 'View ✓' : 'View')
          .setEmoji(p.wantsView ? '🟢' : '⚪')
          .setStyle(p.wantsView ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`games:prefs:toggle:${mode}:${targetUserId}:${p.game.id}:ping`)
          .setLabel(p.wantsPing ? 'Pings ✓' : 'Pings')
          .setEmoji(p.wantsPing ? '🔔' : '⚪')
          .setStyle(p.wantsPing ? ButtonStyle.Success : ButtonStyle.Secondary),
      )
    )
  }

  if (prefs.length > 4) {
    container.addSeparatorComponents(sep())
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `_Showing first 4 of ${prefs.length} games. Pagination coming when the catalog grows._`
    ))
  }

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`games:prefs:back:${mode}:${targetUserId}`).setLabel('Done').setStyle(ButtonStyle.Secondary)
    )
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

// ===========================================================================
// Authorization helpers
// ===========================================================================

async function authorizePrefs(interaction: ButtonInteraction | ModalSubmitInteraction, mode: PrefsMode, targetUserId: string): Promise<boolean> {
  if (mode === 'sudo') return requireSudo(interaction)
  if (interaction.user.id !== targetUserId) {
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ You can only edit your own game prefs.', ephemeral: true })
    }
    return false
  }
  return true
}

// ===========================================================================
// Catalog handlers
// ===========================================================================

export async function handleCatalogButton(interaction: ButtonInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  const id = interaction.customId

  if (id === 'games:cat:list') {
    await interaction.update(await renderCatalogList(interaction.guildId!) as any)
    return
  }

  if (id === 'games:cat:add') {
    const modal = new ModalBuilder()
      .setCustomId('games:cat:add_submit')
      .setTitle('Add a game')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('name').setLabel('Name').setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('aliases').setLabel('Aliases (comma-separated, optional)').setStyle(TextInputStyle.Short).setRequired(false)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('sortOrder').setLabel('Sort order (integer, optional)').setStyle(TextInputStyle.Short).setRequired(false)
        ),
      )
    await interaction.showModal(modal)
    return
  }

  if (id.startsWith('games:cat:edit:')) {
    const [, , , gid, field] = id.split(':')
    const g = getGame(gid)
    if (!g) {
      await interaction.reply({ content: '❌ Game not found.', ephemeral: true })
      return
    }
    let label = field
    let placeholder = ''
    let value = ''
    if (field === 'name') { label = 'Name'; value = g.name }
    else if (field === 'aliases') { label = 'Aliases (comma-separated)'; value = g.aliases.join(', ') }
    else if (field === 'sortOrder') { label = 'Sort order (integer)'; value = String(g.sortOrder); placeholder = 'lower = appears first' }

    const modal = new ModalBuilder()
      .setCustomId(`games:cat:save:${gid}:${field}`)
      .setTitle(`Edit ${label}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('value').setLabel(label)
            .setStyle(TextInputStyle.Short).setRequired(false).setValue(value).setPlaceholder(placeholder)
        )
      )
    await interaction.showModal(modal)
    return
  }

  if (id.startsWith('games:cat:toggle:')) {
    const [, , , gid, flag] = id.split(':')
    const g = getGame(gid)
    if (!g) return
    const patch: Partial<Game> = flag === 'isVisible'
      ? { isVisible: !g.isVisible }
      : flag === 'isArchived'
      ? { isArchived: !g.isArchived }
      : {}
    const updated = await updateGame(gid, patch)
    if (updated) await interaction.update(renderGameDetail(updated) as any)
    return
  }

  if (id.startsWith('games:cat:delete:')) {
    const [, , , gid] = id.split(':')
    await deleteGame(gid)
    await interaction.update(await renderCatalogList(interaction.guildId!) as any)
    return
  }

  if (id.startsWith('games:cat:detail:')) {
    const [, , , gid] = id.split(':')
    const g = getGame(gid)
    if (!g) return
    await interaction.update(renderGameDetail(g) as any)
    return
  }
}

export async function handleCatalogStringSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  if (interaction.customId !== 'games:cat:select') return
  const gid = interaction.values[0]
  const g = getGame(gid)
  if (!g) {
    await interaction.update(await renderCatalogList(interaction.guildId!) as any)
    return
  }
  await interaction.update(renderGameDetail(g) as any)
}

export async function handleCatalogRoleSelect(interaction: RoleSelectMenuInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  const [, , , gid, kind] = interaction.customId.split(':')  // games:cat:role:{gid}:{kind}
  const roleId = interaction.values[0] ?? null
  const patch: Partial<Game> = kind === 'view' ? { roleId } : { pingRoleId: roleId }
  const updated = await updateGame(gid, patch)
  if (updated) await interaction.update(renderGameDetail(updated) as any)
}

export async function handleCatalogModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return

  if (interaction.customId === 'games:cat:add_submit') {
    const name = interaction.fields.getTextInputValue('name').trim()
    const aliasesRaw = interaction.fields.getTextInputValue('aliases').trim()
    const sortRaw = interaction.fields.getTextInputValue('sortOrder').trim()
    const aliases = aliasesRaw === '' ? [] : aliasesRaw.split(',').map(s => s.trim()).filter(Boolean)
    const sortOrder = sortRaw === '' ? 0 : Number(sortRaw)
    if (!Number.isInteger(sortOrder)) {
      await interaction.reply({ content: '❌ Sort order must be an integer.', ephemeral: true })
      return
    }
    const created = await createGame({ guildId: interaction.guildId!, name, aliases, sortOrder })
    if (interaction.isFromMessage()) {
      await interaction.update(renderGameDetail(created) as any)
    } else {
      await interaction.reply({ content: `✅ Created **${created.name}**.`, ephemeral: true })
    }
    return
  }

  if (interaction.customId.startsWith('games:cat:save:')) {
    const [, , , gid, field] = interaction.customId.split(':')
    const g = getGame(gid)
    if (!g) {
      await interaction.reply({ content: '❌ Game not found.', ephemeral: true })
      return
    }
    const raw = interaction.fields.getTextInputValue('value').trim()
    const patch: Partial<Game> = {}
    if (field === 'name') {
      if (raw === '') { await interaction.reply({ content: '❌ Name cannot be empty.', ephemeral: true }); return }
      patch.name = raw
    } else if (field === 'aliases') {
      patch.aliases = raw === '' ? [] : raw.split(',').map(s => s.trim()).filter(Boolean)
    } else if (field === 'sortOrder') {
      const n = Number(raw)
      if (!Number.isInteger(n)) { await interaction.reply({ content: '❌ Must be an integer.', ephemeral: true }); return }
      patch.sortOrder = n
    } else {
      await interaction.reply({ content: `❌ Unknown field: \`${field}\``, ephemeral: true })
      return
    }
    const updated = await updateGame(gid, patch)
    if (updated && interaction.isFromMessage()) {
      await interaction.update(renderGameDetail(updated) as any)
    } else {
      await interaction.reply({ content: '✅ Updated.', ephemeral: true })
    }
    return
  }
}

// ===========================================================================
// Prefs handlers
// ===========================================================================

export async function handlePrefsToggle(interaction: ButtonInteraction): Promise<void> {
  // games:prefs:toggle:{mode}:{uid}:{gid}:{which}
  const [, , , mode, uid, gid, which] = interaction.customId.split(':')
  if (!await authorizePrefs(interaction, mode as PrefsMode, uid)) return

  const member = await interaction.guild!.members.fetch(uid).catch(() => null)
  if (!member) {
    await interaction.reply({ content: '❌ Could not resolve target member.', ephemeral: true })
    return
  }

  await togglePref(member, gid, which as 'view' | 'ping', {
    editorDiscordId: interaction.user.id,
    mode: mode as PrefsMode,
  })

  await interaction.update(await renderPrefsEditor(interaction.guild!, uid, mode as PrefsMode) as any)
}

export async function handlePrefsBack(interaction: ButtonInteraction): Promise<void> {
  const [, , , mode] = interaction.customId.split(':')
  if (mode === 'sudo') {
    if (!await requireSudo(interaction)) return
    await interaction.update(await renderCatalogList(interaction.guildId!) as any)
  } else {
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [
      new ContainerBuilder().setAccentColor(0x57f287).addTextDisplayComponents(
        new TextDisplayBuilder().setContent('✅ Game prefs saved. You can close this.')
      ),
    ] } as any)
  }
}

// ===========================================================================
// Public entry — open prefs directly for a target (for /games and Manage User)
// ===========================================================================

export async function openPrefsEditor(
  reply: (payload: any) => Promise<void>,
  guild: Guild,
  targetUserId: string,
  mode: PrefsMode,
): Promise<void> {
  const payload = await renderPrefsEditor(guild, targetUserId, mode)
  await reply(payload)
}
