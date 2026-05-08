/**
 * Game Night setup — accessible from `/sudo → Game Night`.
 *
 * Flow:
 *   1. Sudo runs /sudo → Game Night → modal (gn:setup_submit) opens.
 *   2. On submit, the bot validates and shows an EPHEMERAL preview of the
 *      announcement with three buttons:
 *        ▸ Send   (gn:preview:send:{sessionKey})   — posts publicly
 *        ▸ Edit   (gn:preview:edit:{sessionKey})   — re-opens the modal
 *                  pre-filled with the previous values
 *        ▸ Cancel (gn:preview:cancel:{sessionKey}) — discards the session
 *   3. The public post never pings any role — game ping roles are
 *      explicitly suppressed by allowedMentions.
 *
 * The pending preview lives in `pendingSessions`, keyed by a short random
 * sessionKey, with a 30-minute TTL.
 *
 * State for live announcements (RSVPs, ownership) is held in `sessions`,
 * keyed by message ID, with parse-from-message recovery on cache miss.
 *
 * customId families:
 *   gn:setup_submit                      modal — fresh submission
 *   gn:setup_submit:{sessionKey}         modal — re-submission from Edit
 *   gn:preview:{send|edit|cancel}:{key}  preview buttons
 *   gn:rsvp:{state}                      RSVP toggle (in | maybe | out)
 *   gn:own:{state}                       ownership toggle (has | needs)
 *   gn:cancel:{hostId}                   cancel a posted Game Night (host or sudo)
 */
import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChannelType,
  ContainerBuilder, MessageFlags, ModalBuilder, ModalSubmitInteraction,
  type MessageActionRowComponentBuilder,
  type StringSelectMenuInteraction, type TextChannel,
  TextDisplayBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js'
import { randomBytes } from 'node:crypto'
import { sep } from '../utils/cv2'
import { findGameByNameOrAlias, getGame, type Game } from '../services/games'
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

// ── Pending previews ───────────────────────────────────────────────────────
// Each one represents a sudo who submitted the setup modal but hasn't yet
// clicked Send. Keyed by a short random sessionKey. 30-min TTL.
interface PendingSession {
  sudoUserId: string
  channelId: string
  /** Raw text the sudo typed for the game lookup — preserved so the Edit
   *  modal can pre-fill exactly what they typed. */
  gameQuery: string
  resolvedGameId: string
  when: string
  notes: string
  createdAt: number
}
const pendingSessions = new Map<string, PendingSession>()
const PENDING_TTL_MS = 30 * 60 * 1000

function newSessionKey(): string {
  return randomBytes(8).toString('hex')
}

function gcPending(): void {
  const now = Date.now()
  for (const [k, p] of pendingSessions) if (now - p.createdAt > PENDING_TTL_MS) pendingSessions.delete(k)
}

// ---------------------------------------------------------------------------
// Setup modal — used for both fresh submissions and Edit re-opens.
// ---------------------------------------------------------------------------

export function buildSetupModal(opts?: { sessionKey?: string; defaults?: { gameQuery: string; when: string; notes: string } }): ModalBuilder {
  const customId = opts?.sessionKey ? `gn:setup_submit:${opts.sessionKey}` : 'gn:setup_submit'
  const game = new TextInputBuilder().setCustomId('game').setLabel('Game (name or alias from catalog)')
    .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. Overwatch')
  const when = new TextInputBuilder().setCustomId('when').setLabel('When (free-form)')
    .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. Saturday 9pm EST')
  const notes = new TextInputBuilder().setCustomId('notes').setLabel('Notes (optional)')
    .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(800)
  if (opts?.defaults) {
    if (opts.defaults.gameQuery) game.setValue(opts.defaults.gameQuery)
    if (opts.defaults.when)      when.setValue(opts.defaults.when)
    if (opts.defaults.notes)     notes.setValue(opts.defaults.notes)
  }
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Schedule Game Night')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(game),
      new ActionRowBuilder<TextInputBuilder>().addComponents(when),
      new ActionRowBuilder<TextInputBuilder>().addComponents(notes),
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
  const when      = interaction.fields.getTextInputValue('when').trim()
  const notes     = interaction.fields.getTextInputValue('notes').trim()

  const game = findGameByNameOrAlias(gameQuery)
  if (!game) {
    await interaction.reply({ content: `❌ No game matches \`${gameQuery}\`. Add it to the catalog first via /sudo → Settings → Games.`, ephemeral: true })
    return
  }

  // Edit submissions reuse the existing sessionKey (so the same preview
  // message can be edited in place). Fresh submissions get a new key.
  const parts = interaction.customId.split(':')
  const isEdit = parts.length >= 3 && parts[2].length > 0
  const sessionKey = isEdit ? parts[2] : newSessionKey()

  const existing = isEdit ? pendingSessions.get(sessionKey) : null
  const channelId = existing?.channelId ?? interaction.channelId
  if (!channelId) {
    await interaction.reply({ content: '❌ Run `/sudo` from a regular text channel.', ephemeral: true })
    return
  }

  const pending: PendingSession = {
    sudoUserId: member.id,
    channelId,
    gameQuery,
    resolvedGameId: game.id,
    when,
    notes,
    createdAt: Date.now(),
  }
  pendingSessions.set(sessionKey, pending)
  gcPending()

  if (isEdit && interaction.isFromMessage()) {
    // Replace the existing preview message in place.
    await interaction.update(buildPreviewPayload(game, pending, sessionKey, true) as any)
  } else {
    await interaction.reply({ ...buildPreviewPayload(game, pending, sessionKey, false), ephemeral: true } as any)
  }
}

// ---------------------------------------------------------------------------
// Preview rendering + button handlers
// ---------------------------------------------------------------------------

function buildPreviewPayload(game: Game, pending: PendingSession, sessionKey: string, _editing: boolean) {
  // Use the same buildPanel renderer for the body so the preview matches the
  // public post 1:1. Pings are off everywhere now, so no role/user mentions
  // resolve regardless.
  const stub: GameNightState = {
    gameId: game.id,
    hostId: pending.sudoUserId,
    when: pending.when,
    notes: pending.notes,
    rsvps: new Map(),
    ownership: new Map(),
  }
  const inner = buildPanel(game, stub)

  const header = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 👀 Preview — Game Night\n_Posting to <#${pending.channelId}>. Nothing has been sent yet._`
      )
    )
    .addSeparatorComponents(sep())

  const previewRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`gn:preview:send:${sessionKey}`).setLabel('Send').setEmoji('📨').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gn:preview:edit:${sessionKey}`).setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gn:preview:cancel:${sessionKey}`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
  )

  // The previewed announcement uses the real buildPanel components, but we
  // skip the live RSVP/ownership/cancel buttons — we don't want sudo to
  // accidentally RSVP on a preview, and the buttons would noop anyway.
  const announcementContainer = inner.components[0]
  return {
    flags: MessageFlags.IsComponentsV2 as number,
    components: [header, announcementContainer, previewRow],
    allowedMentions: { parse: [] as never[] },
  }
}

export async function handlePreviewButton(interaction: ButtonInteraction): Promise<void> {
  // gn:preview:{action}:{sessionKey}
  const parts = interaction.customId.split(':')
  if (parts.length !== 4) return
  const action = parts[2]
  const sessionKey = parts[3]
  const pending = pendingSessions.get(sessionKey)

  if (!pending) {
    await interaction.update({ content: '⌛ This preview expired — run `/sudo → Game Night` again to redo it.', components: [], flags: undefined } as any).catch(async () => {
      await interaction.reply({ content: '⌛ This preview expired.', ephemeral: true }).catch(() => {})
    })
    return
  }

  if (interaction.user.id !== pending.sudoUserId) {
    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null)
    if (!member || !isSudo(member)) {
      await interaction.reply({ content: '❌ Only the sudo who built this preview can act on it.', ephemeral: true })
      return
    }
  }

  const game = getGame(pending.resolvedGameId)
  if (!game) {
    await interaction.update({ content: '❌ The game in this preview was removed from the catalog. Cancel and start over.', components: [], flags: undefined } as any).catch(() => {})
    return
  }

  if (action === 'send') {
    const channel = await interaction.client.channels.fetch(pending.channelId).catch(() => null)
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: `❌ Could not post to <#${pending.channelId}> — channel unavailable.`, ephemeral: true })
      return
    }
    const state: GameNightState = {
      gameId: game.id,
      hostId: pending.sudoUserId,
      when: pending.when,
      notes: pending.notes,
      rsvps: new Map(),
      ownership: new Map(),
    }
    const sent = await (channel as TextChannel).send(buildPanel(game, state) as any)
    sessions.set(sent.id, state)
    pendingSessions.delete(sessionKey)
    logger.info(`gamenight sent game=${game.name} host=${pending.sudoUserId} channel=${channel.id} message=${sent.id}`)

    const ack = new ContainerBuilder().setAccentColor(0x57f287)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`✅ Posted in <#${pending.channelId}>.`))
    await interaction.update({
      flags: MessageFlags.IsComponentsV2 as number,
      components: [ack],
      allowedMentions: { parse: [] as never[] },
    } as any)
    return
  }

  if (action === 'edit') {
    await interaction.showModal(buildSetupModal({
      sessionKey,
      defaults: { gameQuery: pending.gameQuery, when: pending.when, notes: pending.notes },
    }))
    return
  }

  if (action === 'cancel') {
    pendingSessions.delete(sessionKey)
    const ack = new ContainerBuilder().setAccentColor(0xed4245)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('🗑️ Preview discarded.'))
    await interaction.update({
      flags: MessageFlags.IsComponentsV2 as number,
      components: [ack],
      allowedMentions: { parse: [] as never[] },
    } as any)
    return
  }
}

// ---------------------------------------------------------------------------
// Live announcement panel (no pings — never pings the game role)
// ---------------------------------------------------------------------------

function listForRsvp(state: GameNightState, want: Rsvp): string[] {
  return Array.from(state.rsvps.entries()).filter(([, r]) => r === want).map(([id]) => `<@${id}>`)
}
function listForOwnership(state: GameNightState, want: Ownership): string[] {
  return Array.from(state.ownership.entries()).filter(([, o]) => o === want).map(([id]) => `<@${id}>`)
}

function buildPanel(game: Game, state: GameNightState): {
  flags: number
  components: any[]
  allowedMentions: { parse: never[] }
} {
  const lines: string[] = []
  lines.push(`🎲 **Game Night — ${game.name}**`)
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

  // No mention of any kind resolves — nobody gets a notification, regardless
  // of what's typed into game/notes/etc.
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container, rsvpRow, ownRow, cancelRow],
    allowedMentions: { parse: [] },
  }
}

// ---------------------------------------------------------------------------
// Live button handlers
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

  const rsvps = new Map<string, Rsvp>()
  for (const [label, status] of [['Joining', 'in'], ['Might join', 'maybe'], ['Not joining', 'out']] as Array<[string, Rsvp]>) {
    const sectionRe = new RegExp(`${label} \\(\\d+\\):\\*\\* ([^\\n]*)`)
    const m = sectionRe.exec(allText)
    if (!m) continue
    for (const id of (m[1].match(/<@(\d{15,25})>/g) ?? [])) {
      rsvps.set(id.replace(/[^\d]/g, ''), status)
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
