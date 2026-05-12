import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} from 'discord.js'
import { db } from '../db/client'
import { autoChannels, hubChannels, staffApprovals } from '../db/schema'
import { and, count, eq } from 'drizzle-orm'
import { requireSudo } from '../services/voice/permissions'
import { env } from '../config/env'
import { sep } from '../utils/cv2'

export const data = new SlashCommandBuilder()
  .setName('sudo')
  .setDescription('Bot management (sudo only)')
  .setDMPermission(false)

export async function renderSudoHome(): Promise<{ flags: number; components: any[] }> {
  const guildId = env.GUILD_ID
  // count() instead of pulling rows — pending approvals can grow unbounded
  // if a sudo never reviews. Same approach for active channels + hubs since
  // we only need badge numbers here.
  const [channelsCount, hubsCount, pendingCount] = await Promise.all([
    db.select({ n: count() }).from(autoChannels).where(eq(autoChannels.guildId, guildId)),
    db.select({ n: count() }).from(hubChannels).where(eq(hubChannels.guildId, guildId)),
    db.select({ n: count() }).from(staffApprovals)
      .where(and(eq(staffApprovals.guildId, guildId), eq(staffApprovals.status, 'pending'))),
  ])

  const lines = [
    `**Active voice channels:** ${channelsCount[0]?.n ?? 0}`,
    `**Managed hubs:** ${hubsCount[0]?.n ?? 0}`,
    `**Pending staff approvals:** ${pendingCount[0]?.n ?? 0}`,
  ]

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🛡️ Sudo Panel'))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const menu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('sudo:action')
      .setPlaceholder('Choose an action...')
      .addOptions([
        { label: 'Settings', value: 'settings', emoji: '⚙️', description: 'Edit runtime config: sudo users, channels, voice, features' },
        { label: 'Manage user', value: 'manage_user', emoji: '👤', description: 'Pick a member to manage their bot settings' },
        { label: 'Game Night', value: 'gamenight', emoji: '🎲', description: 'Schedule a Game Night announcement with RSVP buttons' },
        { label: 'Active voice channels', value: 'channels', emoji: '🔊' },
        { label: 'Force owner transfer', value: 'force_owner', emoji: '👤', description: 'Manually reassign owner of an auto-channel (bypasses claim/grace)' },
        { label: 'Hub channels', value: 'hubs', emoji: '🪐' },
        { label: 'Force cleanup', value: 'cleanup', emoji: '🧹' },
        { label: 'Pending approvals', value: 'approvals', emoji: '📥' },
        { label: 'Run reconciler', value: 'repair', emoji: '🔧' },
        { label: 'Restart instructions', value: 'restart', emoji: '🔁' },
      ])
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components: [container, menu] }
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  if (!member) return
  // Re-use the same auth path as the rest of the sudo surface.
  const { isSudo } = await import('../services/voice/permissions')
  if (!isSudo(member)) {
    await interaction.reply({ content: '❌ Sudo access required.', ephemeral: true })
    return
  }

  await interaction.deferReply({ ephemeral: true })
  await interaction.editReply(await renderSudoHome() as any)
}

/** Handler for the "Back to /sudo" button on sub-panels. */
export async function handleSudoHomeButton(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  await interaction.update(await renderSudoHome() as any)
}
