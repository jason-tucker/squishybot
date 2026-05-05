import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js'
import { db } from '../db/client'
import { autoChannels, hubChannels } from '../db/schema'
import { eq } from 'drizzle-orm'
import { env } from '../config/env'

export const data = new SlashCommandBuilder()
  .setName('squishy')
  .setDescription('SquishyBot menu')
  .setDMPermission(false)

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const [activeChannels, hubs] = await Promise.all([
    db.select().from(autoChannels).where(eq(autoChannels.guildId, env.GUILD_ID)),
    db.select().from(hubChannels).where(eq(hubChannels.guildId, env.GUILD_ID)),
  ])

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## SquishyBot\n**Active voice channels:** ${activeChannels.length}  •  **Hubs:** ${hubs.length}`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        'Join a **hub** voice channel to create your own private room.\n' +
        'Use **/voice** while in your channel to open the control panel.\n\n' +
        'Want a staff role? Use the button below to submit a request.'
      )
    )

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('open_staff_request')
      .setLabel('Request Staff Role')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary),
  )

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container, row],
  } as any)
}
