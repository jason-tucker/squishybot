import {
  type StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  type MessageActionRowComponentBuilder,
  TextDisplayBuilder,
  MessageFlags,
  UserSelectMenuBuilder,
} from 'discord.js'
import { db } from '../../db/client'
import { autoChannels, hubChannels, staffApprovals } from '../../db/schema'
import { and, eq } from 'drizzle-orm'
import { isSudo } from '../../services/voice/permissions'
import { env } from '../../config/env'
import { sep } from '../../utils/cv2'

export async function handleSudoPanelSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  if (!isSudo(member)) {
    await interaction.reply({ content: '❌ Sudo access required.', ephemeral: true })
    return
  }

  const value = interaction.values[0]

  // Game Night: must show a modal as the first response, so handle BEFORE deferring.
  if (value === 'gamenight') {
    const { showSetupModal } = await import('../../commands/gamenight')
    await showSetupModal(interaction)
    return
  }

  await interaction.deferUpdate()
  const guildId = env.GUILD_ID

  if (value === 'channels') {
    const rows = await db.select().from(autoChannels).where(eq(autoChannels.guildId, guildId))
    const body = rows.length === 0
      ? '_No active auto channels._'
      : rows.map(r => {
          const name = r.manualName ?? '(auto-named)'
          return `${r.isLocked ? '🔒' : '🔓'} **${name}** — <@${r.ownerUserId}> · <#${r.textChannelId}>`
        }).join('\n')
    await sendPanel(interaction, '🔊 Active Voice Channels', body, 0x5865f2)
    return
  }

  if (value === 'hubs') {
    const rows = await db.select().from(hubChannels).where(eq(hubChannels.guildId, guildId))
    const body = rows.length === 0
      ? '_No hubs registered._'
      : rows.map(r => `• **${r.label}** — <#${r.channelId}>`).join('\n')
    await sendPanel(interaction, '🪐 Hub Channels', body, 0x5865f2)
    return
  }

  if (value === 'cleanup') {
    const rows = await db.select().from(autoChannels).where(eq(autoChannels.guildId, guildId))
    const guild = interaction.guild!
    const { deleteAutoChannel } = await import('../../services/voice/autoChannel')
    let deleted = 0, skipped = 0
    for (const r of rows) {
      const vc = await guild.channels.fetch(r.voiceChannelId).catch(() => null)
      if (!vc || (vc.isVoiceBased() && vc.members.size === 0)) {
        await deleteAutoChannel(interaction.client, r)
        deleted++
      } else {
        skipped++
      }
    }
    await sendPanel(interaction, '🧹 Cleanup Complete', `**Deleted:** ${deleted}\n**Skipped (active):** ${skipped}`, 0x57f287)
    return
  }

  if (value === 'approvals') {
    const pending = await db.select().from(staffApprovals)
      .where(and(eq(staffApprovals.guildId, guildId), eq(staffApprovals.status, 'pending')))
    const body = pending.length === 0
      ? '_No pending approvals._'
      : pending.map(a => {
          const d = a.requestedData as Record<string, unknown>
          const summary = Object.entries(d).filter(([, v]) => v).map(([k, v]) => `${k}: \`${v}\``).join(' · ')
          return `• <@${a.userId}> — ${summary}`
        }).join('\n\n')
    await sendPanel(interaction, '📥 Pending Approvals', body, 0xfee75c)
    return
  }

  if (value === 'repair') {
    const { runReconciler } = await import('../../services/voice/reconciler')
    const result = await runReconciler(interaction.client)
    await sendPanel(interaction, '🔧 Reconciler Complete',
      `Recovered: ${result.recovered}\nCleaned: ${result.cleaned}\nHubs: ${result.hubs}\nPanels: ${result.panels}`,
      0x57f287)
    return
  }

  if (value === 'restart') {
    await sendPanel(interaction, '🔁 Restart',
      '```bash\nsquishybot restart    # graceful restart\nsquishybot logs       # live logs\nsquishybot update     # git pull + rebuild + restart\nsquishybot status     # service status\n```',
      0x5865f2)
    return
  }

  if (value === 'settings') {
    const { showSettingsPanel } = await import('../sudoSettings')
    await showSettingsPanel(interaction)
    return
  }

  if (value === 'manage_user') {
    const container = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 👤 Manage user'))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('Pick a member to manage:'))
    const picker = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId('sudo:manage_user_pick')
        .setPlaceholder('Pick a member…')
        .setMinValues(1).setMaxValues(1),
    )
    const back = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:home').setLabel('Back to /sudo').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
    )
    await interaction.editReply({ flags: MessageFlags.IsComponentsV2, components: [container, picker, back] } as any)
    return
  }
}

async function sendPanel(
  interaction: StringSelectMenuInteraction,
  title: string,
  body: string,
  color: number,
): Promise<void> {
  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}`))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body.slice(0, 3500)))

  const back = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:home').setLabel('Back to /sudo').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
  )

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container, back],
  } as any)
}
