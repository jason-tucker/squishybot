import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} from 'discord.js'
import { db } from '../db/client'
import { autoChannels, hubChannels } from '../db/schema'
import { eq } from 'drizzle-orm'
import { isSudo } from '../services/voice/permissions'
import { env } from '../config/env'

export const data = new SlashCommandBuilder()
  .setName('squishy')
  .setDescription('SquishyBot help and user menu')
  .setDMPermission(false)

function sep() {
  return new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })
  await sendMainPanel(interaction, await interaction.guild!.members.fetch(interaction.user.id).then(m => isSudo(m)))
}

export async function sendMainPanel(interaction: ChatInputCommandInteraction | StringSelectMenuInteraction, isSudoUser: boolean): Promise<void> {
  const [activeChannels, hubs] = await Promise.all([
    db.select().from(autoChannels).where(eq(autoChannels.guildId, env.GUILD_ID)),
    db.select().from(hubChannels).where(eq(hubChannels.guildId, env.GUILD_ID)),
  ])

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🤖 SquishyBot\n` +
        `**Active voice channels:** ${activeChannels.length}  •  **Hubs:** ${hubs.length}\n\n` +
        `Use the menu below to explore what SquishyBot can do, or hit the button to request a staff role.`
      )
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Voice channels** — Join a hub to create your own private room with a control panel.\n` +
        `**Staff roles** — Submit a request to join the server staff team.`
      )
    )

  const sections = [
    { label: 'Auto Voice Channels', value: 'voice', emoji: '🔊', description: 'How hub and auto channels work' },
    { label: 'Voice Control Panel', value: 'panel', emoji: '🎛️', description: 'What every button on the panel does' },
    { label: 'Staff Requests', value: 'staff', emoji: '📝', description: 'How to request a staff role' },
    { label: 'Bug & Feature Reports', value: 'report', emoji: '🐛', description: 'How /report works (owner-reviewed GitHub issues)' },
    ...(isSudoUser ? [{ label: 'Admin Tools', value: 'admin', emoji: '🛡️', description: 'Sudo commands and controls' }] : []),
  ]

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('squishy:section')
      .setPlaceholder('Explore sections...')
      .addOptions(sections)
  )

  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('open_staff_request')
      .setLabel('Request Staff Role')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary),
  )

  const payload = { flags: MessageFlags.IsComponentsV2, components: [container, selectRow, buttonRow] }
  if ((interaction as StringSelectMenuInteraction).update) {
    await (interaction as StringSelectMenuInteraction).update(payload as any)
  } else {
    await (interaction as ChatInputCommandInteraction).editReply(payload as any)
  }
}
