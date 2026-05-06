/**
 * /play <game> — LFG ping for a game.
 *
 * Resolves the game by name or alias, checks the per-(user, game) cooldown
 * (30 min, in-memory), and posts in the game's configured channel mentioning
 * its ping-role. Sudo can override the cooldown by passing `force:true`.
 *
 * The bot will never @everyone or @here regardless of arguments. Mentions
 * inside the user-supplied `message` are stripped to prevent abuse.
 */
import {
  ChannelType,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type TextChannel,
} from 'discord.js'
import { isSudo } from '../services/voice/permissions'
import {
  checkPlayCooldown, findGameByNameOrAlias, listGames, markPlayUsed,
} from '../services/games'
import { logger } from '../services/logger'

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Ping the LFG role for a game')
  .setDMPermission(false)
  .addStringOption(o => o
    .setName('game')
    .setDescription('Which game to LFG for (name or alias)')
    .setRequired(true)
    .setAutocomplete(true)
  )
  .addIntegerOption(o => o
    .setName('party_size')
    .setDescription('How many players you need (1–32)')
    .setMinValue(1).setMaxValue(32)
  )
  .addStringOption(o => o
    .setName('when')
    .setDescription('When (e.g. "now", "9pm EST")')
  )
  .addStringOption(o => o
    .setName('platform')
    .setDescription('Platform (PC / PS / Xbox / etc.)')
  )
  .addStringOption(o => o
    .setName('rank')
    .setDescription('Skill / rank info')
  )
  .addStringOption(o => o
    .setName('message')
    .setDescription('Free-form note (200 char max, no role/user mentions)')
  )
  .addBooleanOption(o => o
    .setName('force')
    .setDescription('Sudo only — bypass the per-game cooldown')
  )

function stripMentions(s: string): string {
  // Strip @everyone, @here, role/user/channel raw mentions. Keep readable text.
  return s
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/<@&\d+>/g, '[role]')
    .replace(/<@!?\d+>/g, '[user]')
    .replace(/<#\d+>/g, '[channel]')
}

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

  const force = interaction.options.getBoolean('force') ?? false
  if (force && !sudo) {
    await interaction.editReply({ content: '❌ `force:true` is sudo-only.' })
    return
  }

  if (!force) {
    const check = checkPlayCooldown(interaction.guild.id, member.id, game.id)
    if (!check.ok) {
      const min = Math.floor(check.remainingSec / 60)
      const sec = check.remainingSec % 60
      const wait = min > 0 ? `${min}m ${sec}s` : `${sec}s`
      await interaction.editReply({ content: `🕒 Cooldown — try again in **${wait}**. Sudo can pass \`force:true\` to bypass.` })
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

  const partySize = interaction.options.getInteger('party_size')
  const when = interaction.options.getString('when')
  const platform = interaction.options.getString('platform')
  const rank = interaction.options.getString('rank')
  const messageRaw = interaction.options.getString('message')
  const message = messageRaw ? stripMentions(messageRaw).slice(0, 200) : null

  const ping = game.pingRoleId ? `<@&${game.pingRoleId}>` : ''
  const lines: string[] = []
  lines.push(`${ping} **LFG: ${game.name}** — host <@${member.id}>`.trim())
  const meta: string[] = []
  if (partySize) meta.push(`party of ${partySize}`)
  if (when) meta.push(`when: ${when}`)
  if (platform) meta.push(`platform: ${platform}`)
  if (rank) meta.push(`rank: ${rank}`)
  if (meta.length) lines.push(`-# ${meta.join(' · ')}`)
  if (message) lines.push(message)

  const allowedRoles = game.pingRoleId ? [game.pingRoleId] : []
  await (channel as TextChannel).send({
    content: lines.join('\n'),
    allowedMentions: { users: [member.id], roles: allowedRoles, parse: [] },
  })

  if (!force) markPlayUsed(interaction.guild.id, member.id, game.id)

  logger.info(`/play game=${game.name} host=${member.id} channel=${channel.id} force=${force}`)
  await interaction.editReply({ content: `✅ Posted in <#${channel.id}>.` })
}

export async function autocomplete(interaction: import('discord.js').AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase()
  const games = listGames()
  const matches = games
    .filter(g =>
      g.name.toLowerCase().includes(focused) ||
      g.aliases.some(a => a.toLowerCase().includes(focused))
    )
    .slice(0, 25)
    .map(g => ({ name: g.name, value: g.name }))
  await interaction.respond(matches).catch(() => {})
}
