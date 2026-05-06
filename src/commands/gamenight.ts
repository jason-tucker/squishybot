/**
 * Game Night setup — accessible from `/sudo → Game Night`.
 *
 * Sudo enters a game (resolved via the games catalog), date/time, and
 * optional notes via a modal. The bot posts a Components V2 announcement
 * in the channel set by `channel.gamenight` (configurable in /sudo →
 * Settings → Channels). The announcement carries three RSVP buttons
 * (Joining / Might join / Not joining) plus two ownership buttons
 * (I own it / I don't own it) so the host knows who needs the game.
 *
 * State per announcement is held in-memory keyed by message ID, with
 * parse-from-message recovery so live announcements survive restarts.
 *
 * customId families:
 *   gn:setup_submit          modal — sudo submitted the setup form
 *   gn:rsvp:{state}          button — RSVP toggle (in | maybe | out)
 *   gn:own:{state}           button — ownership toggle (has | needs)
 *   gn:cancel:{hostId}       button — cancel (host or sudo)
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChannelType,
  ContainerBuilder, MessageFlags, ModalBuilder, ModalSubmitInteraction,
  type Guild, type MessageActionRowComponentBuilder,
  type StringSelectMenuInteraction, type TextChannel,
  TextDisplayBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js'
import { sep } from '../utils/cv2'
import { findGameByNameOrAlias, getGame, type Game } from '../services/games'
import { getSetting } from '../services/settings'
import { isSudo } from '../services/voice/permissions'
import { logger } from '../services/logger'

type Rsvp = 'in' | 'maybe' | 'out'
type Ownership = 'has' | 'needs'

interface GameNightState {
  gameId: string
  hostId: string
  when: string
  notes: string
  rsvps: Map<string, Rsvp>
  ownership: Map<string, Ownership>
}

const sessions = new Map<string, GameNightState>()

// ---------------------------------------------------------------------------
// Setup — modal triggered from /sudo top-level select
// ---------------------------------------------------------------------------

export function buildSetupModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('gn:setup_submit')
    .setTitle('Schedule Game Night')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('game').setLabel('Game (name or alias from catalog)')
          .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. Overwatch'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('when').setLabel('When (free-form)')
          .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. Saturday 9pm EST'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('notes').setLabel('Notes (optional)')
          .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(800),
      ),
    )
}

export async function showSetupModal(interaction: StringSelectMenuInteraction): Promise<void> {
  await interaction.showModal(buildSetupModal())
}

export async function handleSetupSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: '❌ Server-only.', ephemeral: true })
    return
  }
  const member = await interaction.guild.members.fetch(interaction.user.id)
  if (!isSudo(member)) {
    await interaction.reply({ content: '❌ Sudo access required.', ephemeral: true })
    return
  }

  const gameQuery = interaction.fields.getTextInputValue('game').trim()
  const when = interaction.fields.getTextInputValue('when').trim()
  const notes = interaction.fields.getTextInputValue('notes').trim()

  const game = findGameByNameOrAlias(gameQuery)
  if (!game) {
    await interaction.reply({ content: `❌ No game matches \`${gameQuery}\`. Add it to the catalog first via /sudo → Settings → Games.`, ephemeral: true })
    return
  }

  const channelId = getSetting('channel.gamenight')
  if (!channelId) {
    await interaction.reply({
      content: '❌ Game Night channel not set. Sudo must set **channel.gamenight** under /sudo → Settings → Channels first.',
      ephemeral: true,
    })
    return
  }
  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null)
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: `❌ \`channel.gamenight\` (<#${channelId}>) is unreachable or not a text channel.`, ephemeral: true })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  const state: GameNightState = {
    gameId: game.id,
    hostId: member.id,
    when,
    notes,
    rsvps: new Map(),
    ownership: new Map(),
  }

  const sent = await (channel as TextChannel).send(buildPanel(game, state, { initialPing: true }) as any)
  sessions.set(sent.id, state)

  logger.info(`gamenight created game=${game.name} host=${member.id} channel=${channel.id} message=${sent.id}`)
  await interaction.editReply({ content: `✅ Game Night posted in <#${channel.id}>.` })
}

// ---------------------------------------------------------------------------
// Panel rendering
// ---------------------------------------------------------------------------

function listForRsvp(state: GameNightState, want: Rsvp): string[] {
  return Array.from(state.rsvps.entries()).filter(([, r]) => r === want).map(([id]) => `<@${id}>`)
}
function listForOwnership(state: GameNightState, want: Ownership): string[] {
  return Array.from(state.ownership.entries()).filter(([, o]) => o === want).map(([id]) => `<@${id}>`)
}

function buildPanel(game: Game, state: GameNightState, options?: { initialPing?: boolean }): {
  flags: number
  components: any[]
  allowedMentions: { roles: string[]; users: string[]; parse: never[] }
} {
  const ping = options?.initialPing && game.pingRoleId ? `<@&${game.pingRoleId}> ` : ''

  const lines: string[] = []
  lines.push(`${ping}🎲 **Game Night — ${game.name}**`)
  lines.push(`📅 ${state.when}`)
  if (state.notes) lines.push('')
  if (state.notes) lines.push(state.notes)

  const joining = listForRsvp(state, 'in')
  const might = listForRsvp(state, 'maybe')
  const out = listForRsvp(state, 'out')
  const needs = listForOwnership(state, 'needs')

  const rsvpLines: string[] = []
  rsvpLines.push(`✅ **Joining (${joining.length}):** ${joining.length ? joining.join(', ') : '_none yet_'}`)
  rsvpLines.push(`🤔 **Might join (${might.length}):** ${might.length ? might.join(', ') : '_none_'}`)
  rsvpLines.push(`❌ **Not joining (${out.length}):** ${out.length ? out.join(', ') : '_none_'}`)
  if (needs.length > 0) {
    rsvpLines.push('')
    rsvpLines.push(`🛒 **Need a copy of the game (${needs.length}):** ${needs.join(', ')}`)
  }

  const container = new ContainerBuilder()
    .setAccentColor(0xfbbf24)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(rsvpLines.join('\n')))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Host: <@${state.hostId}>`))

  const rsvpRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('gn:rsvp:in').setLabel('Joining').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('gn:rsvp:maybe').setLabel('Might join').setEmoji('🤔').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('gn:rsvp:out').setLabel('Not joining').setEmoji('❌').setStyle(ButtonStyle.Secondary),
  )
  const ownRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('gn:own:has').setLabel('I own it').setEmoji('👍').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('gn:own:needs').setLabel("I don't own it").setEmoji('🛒').setStyle(ButtonStyle.Secondary),
  )
  const cancelRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`gn:cancel:${state.hostId}`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  )

  // Mentions: ping role only on initial post; never resolve @everyone/@here.
  const allowedRoles = options?.initialPing && game.pingRoleId ? [game.pingRoleId] : []
  // Ensure mentions for host + every user in the lists are allowed (so the
  // updates don't accidentally fail to render the mention text).
  const userMentionSet = new Set<string>([state.hostId, ...joining.concat(might, out, needs).map(s => s.replace(/[^\d]/g, ''))])
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container, rsvpRow, ownRow, cancelRow],
    allowedMentions: { roles: allowedRoles, users: Array.from(userMentionSet), parse: [] },
  }
}

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------

function getOrRecover(interaction: ButtonInteraction): GameNightState | null {
  const id = interaction.message?.id
  if (!id) return null
  const cached = sessions.get(id)
  if (cached) return cached
  const recovered = recoverFromMessage(interaction)
  if (recovered) sessions.set(id, recovered)
  return recovered
}

export async function handleRsvpButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return
  const state = getOrRecover(interaction)
  if (!state) {
    await interaction.reply({ content: '❌ This Game Night is no longer active.', ephemeral: true })
    return
  }
  const game = getGame(state.gameId)
  if (!game) {
    await interaction.reply({ content: '❌ This game has been removed from the catalog.', ephemeral: true })
    return
  }
  const want = interaction.customId.split(':')[2] as Rsvp
  const userId = interaction.user.id

  // Toggle: clicking the current state again clears it.
  if (state.rsvps.get(userId) === want) state.rsvps.delete(userId)
  else state.rsvps.set(userId, want)

  await interaction.update(buildPanel(game, state) as any)
}

export async function handleOwnershipButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return
  const state = getOrRecover(interaction)
  if (!state) {
    await interaction.reply({ content: '❌ This Game Night is no longer active.', ephemeral: true })
    return
  }
  const game = getGame(state.gameId)
  if (!game) {
    await interaction.reply({ content: '❌ This game has been removed from the catalog.', ephemeral: true })
    return
  }
  const want = interaction.customId.split(':')[2] as Ownership
  const userId = interaction.user.id

  if (state.ownership.get(userId) === want) state.ownership.delete(userId)
  else state.ownership.set(userId, want)

  await interaction.update(buildPanel(game, state) as any)
}

export async function handleCancelButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild || !interaction.message) {
    await interaction.deferUpdate().catch(() => {})
    return
  }
  const hostId = interaction.customId.split(':')[2]
  const member = await interaction.guild.members.fetch(interaction.user.id)
  if (interaction.user.id !== hostId && !isSudo(member)) {
    await interaction.reply({ content: '❌ Only the host or a sudo user can cancel this Game Night.', ephemeral: true })
    return
  }
  sessions.delete(interaction.message.id)
  try {
    await interaction.message.delete()
  } catch {
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [
      new ContainerBuilder().setAccentColor(0xed4245).addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`❌ Game Night cancelled by <@${interaction.user.id}>.`)
      ),
    ] } as any).catch(() => {})
  }
  logger.info(`gamenight cancel by=${interaction.user.id} host=${hostId} message=${interaction.message.id}`)
}

// ---------------------------------------------------------------------------
// Recovery — rebuild a session from an existing message after restart.
// We can't recover the gameId from the message text (the game is just a
// title), so on a cache miss we look up the game by parsing the title.
// ---------------------------------------------------------------------------

function recoverFromMessage(interaction: ButtonInteraction): GameNightState | null {
  const allText = JSON.stringify(interaction.message.components)

  const gameMatch = /Game Night — ([^\\n*]+?)\*\*/.exec(allText)
  if (!gameMatch) return null
  const game = findGameByNameOrAlias(gameMatch[1].trim())
  if (!game) return null

  const hostMatch = /Host: <@(\d{15,25})>/.exec(allText)
  if (!hostMatch) return null
  const hostId = hostMatch[1]

  const whenMatch = /📅 ([^\\n*]+)/.exec(allText)
  const when = whenMatch ? whenMatch[1].trim() : ''

  // RSVPs & ownership: parse mentions out of each labelled section.
  const rsvps = new Map<string, Rsvp>()
  for (const [label, status] of [['Joining', 'in'], ['Might join', 'maybe'], ['Not joining', 'out']] as Array<[string, Rsvp]>) {
    const sectionRe = new RegExp(`${label} \\(\\d+\\):\\*\\* ([^\\n]*)`)
    const m = sectionRe.exec(allText)
    if (!m) continue
    for (const id of (m[1].match(/<@(\d{15,25})>/g) ?? [])) {
      const userId = id.replace(/[^\d]/g, '')
      rsvps.set(userId, status)
    }
  }

  const ownership = new Map<string, Ownership>()
  const needsRe = /Need a copy of the game \(\d+\):\*\* ([^\n]*)/
  const m = needsRe.exec(allText)
  if (m) {
    for (const id of (m[1].match(/<@(\d{15,25})>/g) ?? [])) {
      ownership.set(id.replace(/[^\d]/g, ''), 'needs')
    }
  }

  return { gameId: game.id, hostId, when, notes: '', rsvps, ownership }
}
