import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} from 'discord.js'
import { db } from '../db/client'
import { autoChannels, hubChannels, staffApprovals } from '../db/schema'
import { and, eq } from 'drizzle-orm'
import { isSudo } from '../services/voice/permissions'
import { env } from '../config/env'

export const data = new SlashCommandBuilder()
  .setName('sudo')
  .setDescription('Bot management (sudo only)')
  .setDMPermission(false)

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  if (!isSudo(member)) {
    await interaction.reply({ content: '❌ Sudo access required.', ephemeral: true })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  const guildId = env.GUILD_ID
  const [channels, hubs, pending] = await Promise.all([
    db.select().from(autoChannels).where(eq(autoChannels.guildId, guildId)),
    db.select().from(hubChannels).where(eq(hubChannels.guildId, guildId)),
    db.select().from(staffApprovals).where(and(eq(staffApprovals.guildId, guildId), eq(staffApprovals.status, 'pending'))),
  ])

  const lines = [
    `**Active voice channels:** ${channels.length}`,
    `**Managed hubs:** ${hubs.length}`,
    `**Pending staff approvals:** ${pending.length}`,
  ]

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🛡️ Sudo Panel'))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const menu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('sudo:action')
      .setPlaceholder('Choose an action...')
      .addOptions([
        { label: 'Active voice channels', value: 'channels', emoji: '🔊' },
        { label: 'Hub channels', value: 'hubs', emoji: '🪐' },
        { label: 'Force cleanup', value: 'cleanup', emoji: '🧹' },
        { label: 'Pending approvals', value: 'approvals', emoji: '📥' },
        { label: 'Run reconciler', value: 'repair', emoji: '🔧' },
        { label: 'Restart instructions', value: 'restart', emoji: '🔁' },
      ])
  )

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container, menu],
  } as any)
}
