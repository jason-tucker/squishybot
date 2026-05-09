import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} from 'discord.js'
import { db } from '../db/client'
import { autoChannels, hubChannels } from '../db/schema'
import { eq } from 'drizzle-orm'
import { isSudo } from '../services/voice/permissions'
import { env } from '../config/env'
import { sep } from '../utils/cv2'

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('SquishyBot help — explainers for every feature')
  .setDMPermission(false)

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  await sendHelpPanel(interaction, isSudo(member))
}

export async function sendHelpPanel(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  isSudoUser: boolean,
): Promise<void> {
  const [activeChannels, hubs] = await Promise.all([
    db.select().from(autoChannels).where(eq(autoChannels.guildId, env.GUILD_ID)),
    db.select().from(hubChannels).where(eq(hubChannels.guildId, env.GUILD_ID)),
  ])

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🤖 SquishyBot — Help\n` +
        `**Active voice channels:** ${activeChannels.length}  •  **Hubs:** ${hubs.length}\n\n` +
        `Pick a section below to learn about a feature, or use **/settings** to edit your own profile and game prefs.`
      )
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Quick links**\n` +
        `• \`/settings\` — your profile, birthdays, game prefs\n` +
        `• \`/games\` — pick which games you want View / LFG-ping roles for\n` +
        `• \`/play <game>\` — post an LFG ping\n` +
        `• \`/voice\` — open the control panel for the voice channel you're in\n` +
        `• \`/report\` — file a bug or feature request`
      )
    )

  const sections = [
    { label: 'Auto Voice Channels', value: 'voice', emoji: '🔊', description: 'How hub and auto channels work' },
    { label: 'Voice Control Panel', value: 'panel', emoji: '🎛️', description: 'What every button on the panel does' },
    { label: 'Games & LFG', value: 'games', emoji: '🎮', description: 'How /games and /play work together' },
    { label: 'Game Night', value: 'gamenight', emoji: '🎲', description: 'RSVP / ownership / cancel buttons explained' },
    { label: 'Staff Requests', value: 'staff', emoji: '📝', description: 'How to request a staff role' },
    { label: 'Bug & Feature Reports', value: 'report', emoji: '🐛', description: 'How /report works (owner-reviewed GitHub issues)' },
    ...(isSudoUser ? [{ label: 'Admin Tools', value: 'admin', emoji: '🛡️', description: 'Sudo commands and controls' }] : []),
  ]

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('help:section')
      .setPlaceholder('Explore sections...')
      .addOptions(sections)
  )

  const payload = { flags: MessageFlags.IsComponentsV2, components: [container, selectRow] }
  if ((interaction as StringSelectMenuInteraction).update) {
    await (interaction as StringSelectMenuInteraction).update(payload as any)
  } else {
    await (interaction as ChatInputCommandInteraction).editReply(payload as any)
  }
}
