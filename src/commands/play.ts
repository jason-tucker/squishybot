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
}

const sessions = new Map<string, LfgSession>()

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

  const button = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
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

  // Lock allowed mentions:
  //  - users: just the host (so they don't ping themselves on subsequent edits)
  //  - roles: the ping role IFF this is the initial post
  //  - parse: [] so @everyone/@here are never resolved
  const allowedRoles = options?.initialPing && game.pingRoleId ? [game.pingRoleId] : []

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container, button],
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

  const session: LfgSession = { gameId: game.id, hostId: member.id, players: [] }
  const sent = await (channel as TextChannel).send(buildPanel(game, session, { initialPing: true }) as any)
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
  return { gameId, hostId, players: dedupedPlayers }
}
