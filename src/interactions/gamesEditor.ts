/**
 * Games editor — two distinct surfaces sharing this module:
 *
 *   1. Catalog editor (sudo only) — define games, link roles/channels, archive/delete.
 *      Entry: /sudo → Settings → Games  (renderCatalog → renderGameDetail).
 *
 *   2. Prefs editor — set view/ping toggles per game on a target user.
 *      Entry: /games (mode='self') OR Manage User → Game Prefs (mode='sudo').
 *      Entry: renderPrefsEditor(guild, targetUserId, mode).
 *
 *      Two screens:
 *      - List: container shows the target's current games (View / Pings / role-or-DB),
 *        a StringSelect lists every game with inline status + interest count.
 *        Picking an option drills into Detail.
 *      - Detail: container shows one game (interest count, target's effective state),
 *        with explicit Set buttons for View / Pings + Back.
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
 *   games:prefs:list:{mode}:{uid}                      button — go back to list
 *   games:prefs:pick:{mode}:{uid}                      string-select — pick a game (drill in)
 *   games:prefs:set:{mode}:{uid}:{gid}:{which}:{val}   button — explicit set (val = '1'|'0')
 *   games:prefs:back:{mode}:{uid}                      button — Done / close
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
  ContainerBuilder, MessageFlags,
  ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  TextDisplayBuilder, TextInputBuilder, TextInputStyle,
  type ButtonInteraction, type ChannelSelectMenuInteraction, type Guild,
  type MessageActionRowComponentBuilder, type ModalSubmitInteraction,
  type RoleSelectMenuInteraction, type StringSelectMenuInteraction,
} from 'discord.js'
import { sep } from '../utils/cv2'
import { requireSudo } from '../services/voice/permissions'
import {
  createGame, deleteGame, gameCount, gameInterestCounts, getGame, listGames,
  matchedPingRoleId, matchedViewChannel, resolvePrefs, setPref, updateGame,
  type Game, type ResolvedPref,
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
  lines.push(`**View channel** — ${g.channelId ? `<#${g.channelId}>` : '_unset_'} _(toggling "View" adds/removes a member overwrite here)_`)
  lines.push(`**Ping role** — ${g.pingRoleId ? `<@&${g.pingRoleId}>` : '_unset (will name-match)_'} _(toggling "Pings" adds/removes this role)_`)
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

  // View channel — text channels only.
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`games:cat:channel:${g.id}:view`)
    .setPlaceholder('Game channel (toggled by "Add View")')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum)
    .setMinValues(0).setMaxValues(1)
  if (g.channelId) channelSelect.addDefaultChannels(g.channelId)
  components.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(channelSelect))

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

const SELECT_MAX = 25  // Discord cap on string-select options

function statusEmoji(p: ResolvedPref): string {
  if (p.wantsView && p.wantsPing) return '🟢'
  if (p.wantsView) return '👁️'
  if (p.wantsPing) return '🔔'
  return '⚪'
}

function statusInline(p: ResolvedPref): string {
  // "View ✓ (role) · Pings ✓"
  const view = p.wantsView ? (p.fromRole.view ? 'View✓ᴿ' : 'View✓') : 'View ·'
  const ping = p.wantsPing ? (p.fromRole.ping ? 'Pings✓ᴿ' : 'Pings✓') : 'Pings ·'
  return `${view} • ${ping}`
}

/**
 * Returns a short "⚠️ missing X, Y" warning when a game's catalog row is
 * missing one or more of the fields needed for it to actually function:
 * a view role, a chat channel, or a ping role. Shown to sudo viewers only
 * (regular members shouldn't be told to ask sudo "to fix" a game inline —
 * that lives on the dedicated games-catalog screen).
 */
function setupWarning(g: Game): string | null {
  const missing: string[] = []
  if (!g.roleId)     missing.push('view-role')
  if (!g.channelId)  missing.push('channel')
  if (!g.pingRoleId) missing.push('ping-role')
  return missing.length > 0 ? `⚠️ missing ${missing.join(', ')}` : null
}

/** Top-level entry — renders the LIST view. Detail is renderPrefsDetail.
 *  `viewerIsSudo` controls the inline "needs setup" warnings; defaults to
 *  `mode === 'sudo'` (the sudo-acting-on-behalf path) but can be overridden
 *  by /games (mode='self' on a sudo user) so a sudo running /games on
 *  themselves still sees the warnings. */
export async function renderPrefsEditor(guild: Guild, targetUserId: string, mode: PrefsMode, viewerIsSudo?: boolean) {
  return renderPrefsList(guild, targetUserId, mode, viewerIsSudo)
}

export async function renderPrefsList(guild: Guild, targetUserId: string, mode: PrefsMode, viewerIsSudo?: boolean) {
  const showWarnings = viewerIsSudo ?? (mode === 'sudo')
  const member = await guild.members.fetch(targetUserId).catch(() => null)
  const targetName = member?.displayName ?? `<@${targetUserId}>`
  const prefs = await resolvePrefs(guild, member ?? targetUserId)
  const interest = await gameInterestCounts(guild)

  const lines: string[] = [`### 🎮 Game Prefs — ${targetName}`]
  lines.push(mode === 'sudo'
    ? '_Sudo edit. Toggling syncs the corresponding Discord role on the target._'
    : '_Pick a game from the dropdown to toggle View access and LFG pings._')
  lines.push('')

  if (prefs.length === 0) {
    lines.push('_No games defined yet. Ask sudo to set up the catalog at `/sudo → Settings → Games`._')
  } else {
    const fmtLine = (p: ResolvedPref) => {
      const v = p.wantsView ? (p.fromRole.view ? '🟢ᴿ' : '🟢') : '⚪'
      const r = p.wantsPing ? (p.fromRole.ping ? '🔔ᴿ' : '🔔') : '⚪'
      const active = p.wantsView || p.wantsPing
      const name = active ? `**${p.game.name}**` : p.game.name
      const warn = showWarnings ? setupWarning(p.game) : null
      return `${v} ${r}  ${name}${warn ? `  · _${warn}_` : ''}`
    }
    const active = prefs.filter(p => p.wantsView || p.wantsPing)
    const inactive = prefs.filter(p => !p.wantsView && !p.wantsPing)

    if (active.length > 0) {
      lines.push('**Your games**')
      for (const p of active) lines.push(fmtLine(p))
    }
    if (inactive.length > 0) {
      if (active.length > 0) lines.push('')
      lines.push(active.length > 0 ? '**Available**' : '**Games**')
      for (const p of inactive) lines.push(fmtLine(p))
    }

    if (prefs.some(p => p.fromRole.view || p.fromRole.ping)) {
      lines.push('')
      lines.push('-# ᴿ = inferred from a Discord role you already have. Toggle to make it explicit.')
    }
  }

  const container = new ContainerBuilder()
    .setAccentColor(mode === 'sudo' ? 0xed4245 : 0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]

  if (prefs.length > 0) {
    // Discord caps each option's description at 100 chars; we trim defensively.
    const opts = prefs.slice(0, SELECT_MAX).map(p => {
      const c = interest.get(p.game.id)
      const interestStr = c ? `${c.view} view · ${c.ping} ping` : '0 view · 0 ping'
      const desc = `Yours: ${statusInline(p)} — ${interestStr}`.slice(0, 100)
      return {
        label: p.game.name.slice(0, 100),
        value: p.game.id,
        description: desc,
        emoji: statusEmoji(p),
      }
    })

    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`games:prefs:pick:${mode}:${targetUserId}`)
          .setPlaceholder('Pick a game to toggle View / Pings…')
          .addOptions(opts)
      )
    )

    if (prefs.length > SELECT_MAX) {
      container.addSeparatorComponents(sep())
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# Showing first ${SELECT_MAX} of ${prefs.length} games. Ask sudo to archive unused ones.`
      ))
    }
  }

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`games:prefs:back:${mode}:${targetUserId}`).setLabel('Done').setStyle(ButtonStyle.Secondary)
    )
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

export async function renderPrefsDetail(
  guild: Guild,
  targetUserId: string,
  mode: PrefsMode,
  gameId: string,
) {
  const game = getGame(gameId)
  if (!game) return renderPrefsList(guild, targetUserId, mode)

  const member = await guild.members.fetch(targetUserId).catch(() => null)
  const targetName = member?.displayName ?? `<@${targetUserId}>`

  // Effective state for this single game.
  const all = await resolvePrefs(guild, member ?? targetUserId)
  const p = all.find(r => r.game.id === gameId)
  if (!p) return renderPrefsList(guild, targetUserId, mode)

  const interest = (await gameInterestCounts(guild)).get(gameId) ?? { view: 0, ping: 0, any: 0 }

  // View is now backed by a per-channel permission overwrite on game.channelId.
  // Ping is backed by the matched ping role (explicit OR name-fallback).
  const viewChannel = matchedViewChannel(guild, game)
  const pingRoleId = matchedPingRoleId(guild, game)

  const viewLabel = (() => {
    if (!viewChannel) return '⚪ no channel linked'
    const tag = `<#${viewChannel.id}>`
    if (!p.wantsView) return `⚪ no — ${tag}`
    return `🟢 yes${p.fromRole.view ? ' _(via existing channel access, not yet saved)_' : ''} — ${tag}`
  })()
  const pingLabel = (() => {
    if (!pingRoleId) return '⚪ no role linked'
    const tag = `<@&${pingRoleId}>`
    if (!p.wantsPing) return `⚪ no — ${tag}`
    return `🔔 yes${p.fromRole.ping ? ' _(via existing role, not yet saved)_' : ''} — ${tag}`
  })()

  const lines: string[] = []
  lines.push(`### 🎮 ${game.name}`)
  if (game.aliases.length) lines.push(`_aka ${game.aliases.join(', ')}_`)
  lines.push('')
  lines.push(`**${targetName}'s prefs**`)
  lines.push(`• View access — ${viewLabel}`)
  lines.push(`• LFG pings — ${pingLabel}`)
  lines.push('')
  lines.push(`**Server interest** — ${interest.view} with channel access · ${interest.ping} with pings · **${interest.any} interested overall**`)

  const container = new ContainerBuilder()
    .setAccentColor(mode === 'sudo' ? 0xed4245 : 0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  // Buttons show current state (label + color); clicking toggles.
  const viewBtn = new ButtonBuilder()
    .setCustomId(`games:prefs:set:${mode}:${targetUserId}:${gameId}:view:${p.wantsView ? '0' : '1'}`)
    .setLabel(p.wantsView ? 'Channel: Joined' : 'Channel: Not joined')
    .setEmoji(p.wantsView ? '👁️' : '🚪')
    .setStyle(p.wantsView ? ButtonStyle.Success : ButtonStyle.Danger)
    .setDisabled(!viewChannel)

  const pingBtn = new ButtonBuilder()
    .setCustomId(`games:prefs:set:${mode}:${targetUserId}:${gameId}:ping:${p.wantsPing ? '0' : '1'}`)
    .setLabel(p.wantsPing ? 'Pings: On' : 'Pings: Off')
    .setEmoji(p.wantsPing ? '🔔' : '🔕')
    .setStyle(p.wantsPing ? ButtonStyle.Success : ButtonStyle.Danger)
    .setDisabled(!pingRoleId)

  const components: any[] = [
    container,
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(viewBtn, pingBtn),
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`games:prefs:list:${mode}:${targetUserId}`).setLabel('Back to list').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`games:prefs:back:${mode}:${targetUserId}`).setLabel('Done').setStyle(ButtonStyle.Secondary),
    ),
  ]

  if (!viewChannel || !pingRoleId) {
    container.addSeparatorComponents(sep())
    const missing: string[] = []
    if (!viewChannel) missing.push('a game channel linked')
    if (!pingRoleId) missing.push('a ping role linked (no role named like the game found)')
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `-# ⚠️ This game has no ${missing.join(' and ')}. Sudo can wire one up at \`/sudo → Settings → Games\`.`
    ))
  }

  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

// ===========================================================================
// Authorization helpers
// ===========================================================================

async function authorizePrefs(
  interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  mode: PrefsMode,
  targetUserId: string,
): Promise<boolean> {
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
  // Only ping is wired through the catalog role-select now; legacy `view` kind
  // is accepted for backward compat with any stale messages but writes pingRoleId
  // to avoid silently re-introducing the deprecated view role behavior.
  const patch: Partial<Game> = kind === 'view' ? { roleId } : { pingRoleId: roleId }
  const updated = await updateGame(gid, patch)
  if (updated) await interaction.update(renderGameDetail(updated) as any)
}

export async function handleCatalogChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  const [, , , gid, kind] = interaction.customId.split(':')  // games:cat:channel:{gid}:{kind}
  const channelId = interaction.values[0] ?? null
  const patch: Partial<Game> = kind === 'category' ? { categoryId: channelId } : { channelId }
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

/** games:prefs:list:{mode}:{uid} — back to the dropdown list view. */
export async function handlePrefsList(interaction: ButtonInteraction): Promise<void> {
  const [, , , mode, uid] = interaction.customId.split(':')
  if (!await authorizePrefs(interaction, mode as PrefsMode, uid)) return
  await interaction.update(await renderPrefsList(interaction.guild!, uid, mode as PrefsMode) as any)
}

/** games:prefs:pick:{mode}:{uid} — string-select picked a game; drill into detail. */
export async function handlePrefsPick(interaction: StringSelectMenuInteraction): Promise<void> {
  const [, , , mode, uid] = interaction.customId.split(':')
  if (!await authorizePrefs(interaction, mode as PrefsMode, uid)) return
  const gid = interaction.values[0]
  if (!gid) {
    await interaction.update(await renderPrefsList(interaction.guild!, uid, mode as PrefsMode) as any)
    return
  }
  await interaction.update(await renderPrefsDetail(interaction.guild!, uid, mode as PrefsMode, gid) as any)
}

/** games:prefs:set:{mode}:{uid}:{gid}:{which}:{value} — explicit set, then re-render detail. */
export async function handlePrefsSet(interaction: ButtonInteraction): Promise<void> {
  const [, , , mode, uid, gid, which, valStr] = interaction.customId.split(':')
  if (!await authorizePrefs(interaction, mode as PrefsMode, uid)) return

  const member = await interaction.guild!.members.fetch(uid).catch(() => null)
  if (!member) {
    await interaction.reply({ content: '❌ Could not resolve target member.', ephemeral: true })
    return
  }

  const value = valStr === '1'
  const result = await setPref(member, gid, which as 'view' | 'ping', value, {
    editorDiscordId: interaction.user.id,
    mode: mode as PrefsMode,
  })
  if (!result) {
    await interaction.reply({ content: '❌ Game not found.', ephemeral: true })
    return
  }

  await interaction.update(await renderPrefsDetail(interaction.guild!, uid, mode as PrefsMode, gid) as any)
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
