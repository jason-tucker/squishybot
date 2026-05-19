/**
 * /play <game>
 *
 * Posts a Components V2 LFG message in the game's channel pinging the
 * configured ping_role_id. The message lists the host and any members who
 * subsequently click the "I want to play!" button (toggle: clicking again
 * removes you).
 *
 * Player-list state is held in-memory keyed by message ID; on a cache miss
 * (e.g. after a bot restart) the handler re-derives the list by parsing
 * mentions out of the message itself.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  ContainerBuilder,
  type AutocompleteInteraction,
  type MessageActionRowComponentBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextDisplayBuilder,
  type TextChannel,
} from 'discord.js'
import { isSudo } from '../services/voice/permissions'
import {
  checkPlayCooldown,
  findGameByNameOrAlias,
  getGame,
  listGames,
  markPlayUsed,
  type Game,
} from '../services/games'
import { sep } from '../utils/cv2'
import { logger } from '../services/logger'

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Start an LFG ping for a game — others can join with one click')
  .setDMPermission(false)
  .addStringOption(o => o
    .setName('game')
    .setDescription('Which game (name or alias)')
    .setRequired(true)
    .setAutocomplete(true)
  )

// ---------------------------------------------------------------------------
// In-memory session state, keyed by message ID
// ---------------------------------------------------------------------------

interface LfgSession {
  gameId: string
  hostId: string
  /** Excludes the host. Order = click order. */
  players: string[]
  /** When the session was created — used to expire stale entries. */
  createdAt: number
}

const sessions = new Map<string, LfgSession>()
/** LFG sessions are useful for ~24h. The `parse-from-message` fallback in
 *  ensureSession handles older messages, so dropping the in-memory entry
 *  isn't lossy — it just costs one extra parse on the next click. */
const SESSION_TTL_MS = 24 * 60 * 60_000

function sweepSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [k, s] of sessions) if (s.createdAt < cutoff) sessions.delete(k)
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function buildPanel(game: Game, session: LfgSession, options?: { initialPing?: boolean }): {
  flags: number
  components: any[]
  allowedMentions: { roles: string[]; users: string[]; parse: never[] }
} {
  const headerLine = options?.initialPing && game.pingRoleId
    ? `<@&${game.pingRoleId}> **🎮 LFG: ${game.name}**`
    : `**🎮 LFG: ${game.name}**`

  const playerLines: string[] = [`👑 <@${session.hostId}> _(host)_`]
  for (const id of session.players) playerLines.push(`• <@${id}>`)
  const total = 1 + session.players.length

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLine))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**Players (${total})**\n${playerLines.join('\n')}`
    ))

  const primaryRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`play:join:${game.id}`)
      .setLabel('I want to play!')
      .setEmoji('🎮')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`play:cancel:${session.hostId}`)
      .setLabel('Cancel')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Danger),
  )

  // Secondary row: Help + Notify toggle. Discord can't render different
  // labels per viewer on a shared message — the click handler reads the
  // clicker's current ping-role state and the ephemeral confirmation
  // calls out the resulting state ("you're now notified" / "muted").
  // Notify is hidden when the game has no ping role configured (nothing
  // meaningful to toggle).
  const secondaryButtons: ButtonBuilder[] = [
    new ButtonBuilder()
      .setCustomId(`play:help:${game.id}`)
      .setLabel('Help')
      .setEmoji('❔')
      .setStyle(ButtonStyle.Secondary),
  ]
  if (game.pingRoleId) {
    secondaryButtons.push(
      new ButtonBuilder()
        .setCustomId(`play:notify:${game.id}`)
        .setLabel('Notify Toggle')
        .setEmoji('🔔')
        .setStyle(ButtonStyle.Secondary),
    )
  }
  const secondaryRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...secondaryButtons)

  // Lock allowed mentions:
  //  - users: just the host (so they don't ping themselves on subsequent edits)
  //  - roles: the ping role IFF this is the initial post
  //  - parse: [] so @everyone/@here are never resolved
  const allowedRoles = options?.initialPing && game.pingRoleId ? [game.pingRoleId] : []

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container, primaryRow, secondaryRow],
    allowedMentions: { roles: allowedRoles, users: [session.hostId], parse: [] },
  }
}

// ---------------------------------------------------------------------------
// Command + autocomplete
// ---------------------------------------------------------------------------

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: '❌ Server-only.', ephemeral: true })
    return
  }
  await interaction.deferReply({ ephemeral: true })

  const member = await interaction.guild.members.fetch(interaction.user.id)
  const sudo = isSudo(member)

  const query = interaction.options.getString('game', true)
  const game = findGameByNameOrAlias(query)
  if (!game) {
    await interaction.editReply({ content: `❌ No game matches \`${query}\`. Try \`/games\` to see what's available.` })
    return
  }
  if (game.isArchived || !game.isVisible) {
    await interaction.editReply({ content: `❌ **${game.name}** is not active for LFG right now.` })
    return
  }

  // Sudo bypasses the cooldown entirely — no flag needed.
  if (!sudo) {
    const check = checkPlayCooldown(interaction.guild.id, member.id, game.id)
    if (!check.ok) {
      const m = Math.floor(check.remainingSec / 60), s = check.remainingSec % 60
      const wait = m > 0 ? `${m}m ${s}s` : `${s}s`
      await interaction.editReply({ content: `🕒 Cooldown — try again in **${wait}**.` })
      return
    }
  }

  if (!game.channelId) {
    await interaction.editReply({ content: `❌ **${game.name}** has no channel configured. Sudo: set one at /sudo → Settings → Games.` })
    return
  }
  const channel = await interaction.guild.channels.fetch(game.channelId).catch(() => null)
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.editReply({ content: `❌ **${game.name}**'s channel is unreachable or not text-type.` })
    return
  }

  const me = await interaction.guild.members.fetchMe()
  if (!(channel as TextChannel).permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
    await interaction.editReply({ content: `❌ Bot lacks Send Messages in <#${channel.id}>.` })
    return
  }

  const session: LfgSession = { gameId: game.id, hostId: member.id, players: [], createdAt: Date.now() }
  const sent = await (channel as TextChannel).send(buildPanel(game, session, { initialPing: true }) as any)
  if (sessions.size > 200) sweepSessions()
  sessions.set(sent.id, session)

  if (!sudo) markPlayUsed(interaction.guild.id, member.id, game.id)
  logger.info(`/play game=${game.name} host=${member.id} message=${sent.id} sudo=${sudo}`)
  await interaction.editReply({ content: `✅ Posted in <#${channel.id}>.` })
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase()
  const matches = listGames()
    .filter(g =>
      g.name.toLowerCase().includes(focused) ||
      g.aliases.some(a => a.toLowerCase().includes(focused))
    )
    .slice(0, 25)
    .map(g => ({ name: g.name, value: g.name }))
  await interaction.respond(matches).catch(() => {})
}

// ---------------------------------------------------------------------------
// Join button — toggles the clicker's presence in the player list.
// ---------------------------------------------------------------------------

export async function handleJoinButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild || !interaction.message) {
    await interaction.deferUpdate().catch(() => {})
    return
  }

  const messageId = interaction.message.id
  let session = sessions.get(messageId)

  // Cache miss (e.g. after a restart): rebuild from the message itself.
  if (!session) {
    const recovered = recoverSessionFromMessage(interaction)
    if (!recovered) {
      await interaction.reply({ content: '❌ This LFG session is no longer active.', ephemeral: true })
      return
    }
    session = recovered
    sessions.set(messageId, session)
  }

  const game = getGame(session.gameId)
  if (!game) {
    await interaction.reply({ content: '❌ This game has been removed from the catalog.', ephemeral: true })
    return
  }

  const userId = interaction.user.id
  if (userId === session.hostId) {
    await interaction.reply({ content: 'You\'re the host — you\'re already in. Delete the message to cancel.', ephemeral: true })
    return
  }

  const idx = session.players.indexOf(userId)
  if (idx === -1) session.players.push(userId)
  else session.players.splice(idx, 1)

  await interaction.update(buildPanel(game, session) as any)
}

/**
 * Cancel an LFG session. Allowed for the host (encoded in the customId so
 * cancel works even after a restart) and any sudo user. Deletes the message.
 */
export async function handleCancelButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild || !interaction.message) {
    await interaction.deferUpdate().catch(() => {})
    return
  }

  const hostId = interaction.customId.split(':')[2]
  const member = await interaction.guild.members.fetch(interaction.user.id)
  const allowed = interaction.user.id === hostId || isSudo(member)
  if (!allowed) {
    await interaction.reply({ content: '❌ Only the host or a sudo user can cancel this LFG.', ephemeral: true })
    return
  }

  sessions.delete(interaction.message.id)
  try {
    await interaction.message.delete()
  } catch {
    // Fall back to a benign edit if delete fails (e.g. permission missing).
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [
      new ContainerBuilder().setAccentColor(0xed4245).addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`❌ LFG cancelled by <@${interaction.user.id}>.`)
      ),
    ] } as any).catch(() => {})
  }
  logger.info(`/play cancel by=${interaction.user.id} host=${hostId} message=${interaction.message.id}`)
}

/** Rebuild a session from an existing message's text (mentions only). */
function recoverSessionFromMessage(interaction: ButtonInteraction): LfgSession | null {
  const gameId = interaction.customId.split(':')[2]
  if (!gameId) return null
  // Components V2: the panel content is in the Container's TextDisplay components.
  // The interaction message's `components` array preserves them.
  const allText = JSON.stringify(interaction.message.components)
  const mentions = Array.from(allText.matchAll(/<@(\d{15,25})>/g)).map(m => m[1])
  if (mentions.length === 0) return null
  const [hostId, ...players] = mentions
  const seen = new Set<string>([hostId])
  const dedupedPlayers: string[] = []
  for (const id of players) {
    if (seen.has(id)) continue
    seen.add(id)
    dedupedPlayers.push(id)
  }
  // Recovered sessions get a fresh createdAt — we can't recover the original
  // from message contents, and a freshly-recovered entry shouldn't be
  // immediately swept on the next size-trigger.
  return { gameId, hostId, players: dedupedPlayers, createdAt: Date.now() }
}

// ---------------------------------------------------------------------------
// Help button — ephemeral explainer for users wondering "wtf is /play".
// ---------------------------------------------------------------------------

export async function handleHelpButton(interaction: ButtonInteraction): Promise<void> {
  const gameId = interaction.customId.split(':')[2]
  const game = getGame(gameId)
  const gameName = game?.name ?? 'this game'
  await interaction.reply({
    ephemeral: true,
    content:
      `**What is /play?**\n` +
      `It's a quick way to say "I'm playing **${gameName}** right now, who wants to join?" The host posts a CV2 panel with a player list; anyone who wants in clicks **🎮 I want to play!** to be added.\n\n` +
      `**About the buttons**\n` +
      `• **🎮 I want to play!** — adds you to the player list (or removes you if you're already on it).\n` +
      `• **✖️ Cancel** — host-only, ends the session.\n` +
      `• **❔ Help** — this card.\n` +
      `• **🔔 Notify Toggle** — adds or removes the game's ping role for you, so future \`/play ${gameName}\` posts ping you (or don't). Each click flips your state and tells you which way it went.\n\n` +
      `**Cooldown**: 30 min per (you, game) so the channel doesn't get spammed.\n` +
      `**Don't want to be pinged anymore?** Click 🔔 Notify Toggle on any post for this game, or open \`Manage Games\` on the dashboard.`,
  })
}

// ---------------------------------------------------------------------------
// Notify-toggle button — adds the game's ping role to the clicker if they
// don't have it; removes it if they do. The PUBLIC button can't show
// different labels per viewer (Discord limitation), so the ephemeral
// confirmation owns the "you're now notified / muted" framing.
// ---------------------------------------------------------------------------

export async function handleNotifyToggleButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ ephemeral: true, content: '❌ Server-only.' })
    return
  }
  const gameId = interaction.customId.split(':')[2]
  const game = getGame(gameId)
  if (!game) {
    await interaction.reply({ ephemeral: true, content: '❌ Game not found (it may have been removed).' })
    return
  }
  if (!game.pingRoleId) {
    await interaction.reply({
      ephemeral: true,
      content: `❌ **${game.name}** has no ping role configured, so there's nothing to toggle. Sudo: link one at \`/sudo → Settings → Games\`.`,
    })
    return
  }
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
  if (!member) {
    await interaction.reply({ ephemeral: true, content: '❌ Couldn\'t resolve your member.' })
    return
  }
  const hasRole = member.roles.cache.has(game.pingRoleId)
  try {
    if (hasRole) {
      await member.roles.remove(game.pingRoleId, `/play notify toggle off`)
      await interaction.reply({
        ephemeral: true,
        content: `🔕 **Muted** — you won't be pinged when someone runs \`/play ${game.name}\`. Click **🔔 Notify Toggle** again to re-enable.`,
      })
    } else {
      await member.roles.add(game.pingRoleId, `/play notify toggle on`)
      await interaction.reply({
        ephemeral: true,
        content: `🔔 **Get Notified** — you'll be pinged when someone runs \`/play ${game.name}\`. Click **🔔 Notify Toggle** again to mute.`,
      })
    }
    logger.info(`play.notify_toggle user=${member.id} game=${game.name} was=${hasRole ? 'on' : 'off'} now=${hasRole ? 'off' : 'on'}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    logger.warn(`play.notify_toggle failed user=${member.id} game=${game.name}: ${msg}`)
    await interaction.reply({
      ephemeral: true,
      content: `❌ Couldn't toggle the role: ${msg}. The bot may be missing **Manage Roles** or the ping role may be above the bot's top role.`,
    })
  }
}
