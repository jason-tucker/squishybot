import { SlashCommandBuilder, ChatInputCommandInteraction, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags } from 'discord.js'
import { db } from '../db/client'
import { autoChannels, hubChannels } from '../db/schema'
import { eq } from 'drizzle-orm'
import { isSudo } from '../services/voice/permissions'
import { env } from '../config/env'

export const data = new SlashCommandBuilder()
  .setName('squishy')
  .setDescription('SquishyBot management commands')
  .setDMPermission(false)
  .addSubcommand(sub =>
    sub.setName('status').setDescription('Show bot status and active channel counts')
  )
  .addSubcommand(sub =>
    sub.setName('repair').setDescription('Run the channel reconciler (sudo only)')
  )

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand()

  if (sub === 'status') {
    await interaction.deferReply({ ephemeral: true })

    const [activeChannels, hubs] = await Promise.all([
      db.select().from(autoChannels).where(eq(autoChannels.guildId, env.GUILD_ID)),
      db.select().from(hubChannels).where(eq(hubChannels.guildId, env.GUILD_ID)),
    ])

    const uptimeMs = process.uptime() * 1000
    const uptimeStr = formatUptime(uptimeMs)

    const container = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## 🤖 SquishyBot Status')
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**Uptime:** ${uptimeStr}\n` +
          `**Guild:** ${env.GUILD_ID}\n` +
          `**Active voice channels:** ${activeChannels.length}\n` +
          `**Managed hubs:** ${hubs.length}`
        )
      )

    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      content: null,
    })
    return
  }

  if (sub === 'repair') {
    const member = await interaction.guild!.members.fetch(interaction.user.id)
    if (!isSudo(member)) {
      await interaction.reply({ content: '❌ This command requires sudo permissions.', ephemeral: true })
      return
    }

    await interaction.deferReply({ ephemeral: true })

    // Import reconciler lazily to avoid circular deps at module load time
    const { runReconciler } = await import('../services/voice/reconciler')
    const result = await runReconciler(interaction.client)

    const container = new ContainerBuilder()
      .setAccentColor(0x57f287)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## 🔧 Repair Complete')
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**Channels recovered:** ${result.recovered}\n` +
          `**Orphans cleaned:** ${result.cleaned}\n` +
          `**Hubs verified/recreated:** ${result.hubs}\n` +
          `**Panels repaired:** ${result.panels}`
        )
      )

    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      content: null,
    })
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}
