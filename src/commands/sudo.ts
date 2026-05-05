import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} from 'discord.js'
import { db } from '../db/client'
import { autoChannels, hubChannels, staffApprovals } from '../db/schema'
import { and, eq } from 'drizzle-orm'
import { isSudo } from '../services/voice/permissions'
import { env } from '../config/env'

export const data = new SlashCommandBuilder()
  .setName('sudo')
  .setDescription('SquishyBot management — sudo only')
  .setDMPermission(false)
  .addSubcommand(s => s.setName('channels').setDescription('List active auto voice channels'))
  .addSubcommand(s => s.setName('hubs').setDescription('List managed hub voice channels'))
  .addSubcommand(s => s.setName('cleanup').setDescription('Force cleanup of stale/empty auto channels'))
  .addSubcommand(s => s.setName('approvals').setDescription('List pending staff approvals'))
  .addSubcommand(s => s.setName('restart').setDescription('Show restart instructions for the terminal'))

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  if (!isSudo(member)) {
    await interaction.reply({ content: '❌ This command requires sudo permissions.', ephemeral: true })
    return
  }

  await interaction.deferReply({ ephemeral: true })

  const sub = interaction.options.getSubcommand()
  const guildId = env.GUILD_ID

  if (sub === 'channels') {
    const rows = await db.select().from(autoChannels).where(eq(autoChannels.guildId, guildId))
    const lines = rows.length === 0
      ? ['_No active auto channels._']
      : rows.map(r => {
          const name = r.manualName ?? '(auto-named)'
          const lock = r.isLocked ? '🔒' : '🔓'
          return `${lock} **${name}** — owner <@${r.ownerUserId}> · vc \`${r.voiceChannelId}\` · tc <#${r.textChannelId}>`
        })

    await sendContainer(interaction, '📋 Active Auto Channels', lines.join('\n'), 0x5865f2)
    return
  }

  if (sub === 'hubs') {
    const rows = await db.select().from(hubChannels).where(eq(hubChannels.guildId, guildId))
    const lines = rows.length === 0
      ? ['_No hubs registered. Set HUB_CHANNEL_IDS in .env._']
      : rows.map(r => `• **${r.label}** — <#${r.channelId}> in category \`${r.categoryId}\``)

    await sendContainer(interaction, '🪐 Managed Hub Channels', lines.join('\n'), 0x5865f2)
    return
  }

  if (sub === 'cleanup') {
    const rows = await db.select().from(autoChannels).where(eq(autoChannels.guildId, guildId))
    const guild = interaction.guild!
    const { deleteAutoChannel } = await import('../services/voice/autoChannel')

    let deleted = 0
    let skipped = 0

    for (const r of rows) {
      const vc = await guild.channels.fetch(r.voiceChannelId).catch(() => null)
      if (!vc) {
        await deleteAutoChannel(interaction.client, r)
        deleted++
      } else if (vc.isVoiceBased() && vc.members.size === 0) {
        await deleteAutoChannel(interaction.client, r)
        deleted++
      } else {
        skipped++
      }
    }

    await sendContainer(
      interaction,
      '🧹 Cleanup Complete',
      `**Deleted:** ${deleted}\n**Skipped (still active):** ${skipped}`,
      0x57f287,
    )
    return
  }

  if (sub === 'approvals') {
    const pending = await db.select().from(staffApprovals)
      .where(and(eq(staffApprovals.guildId, guildId), eq(staffApprovals.status, 'pending')))

    const lines = pending.length === 0
      ? ['_No pending approvals._']
      : pending.map(a => {
          const data = a.requestedData as Record<string, unknown>
          const summary = Object.entries(data).map(([k, v]) => `${k}: \`${String(v)}\``).join(' · ')
          return `• <@${a.userId}> — ${summary}\n  [Jump to thread](${a.approvalMsgId ? `https://discord.com/channels/${guildId}/${env.STAFF_APPROVAL_THREAD_ID}/${a.approvalMsgId}` : 'no message id'})`
        })

    await sendContainer(interaction, '📥 Pending Staff Approvals', lines.join('\n\n'), 0xfee75c)
    return
  }

  if (sub === 'restart') {
    const text =
      '**Terminal commands** (run on the VPS):\n\n' +
      '```bash\n' +
      'squishybot restart    # graceful restart with migrations\n' +
      'squishybot status     # service status\n' +
      'squishybot logs       # live logs (Ctrl+C to exit)\n' +
      'squishybot tail 50    # last 50 log lines\n' +
      'squishybot deploy     # redeploy slash commands\n' +
      'squishybot update     # git pull + migrate + redeploy + restart\n' +
      '```\n\n' +
      'If `squishybot` isn\'t on PATH yet, run:\n' +
      '```bash\n' +
      'sudo cp /home/botuser/projects/squishybot/scripts/squishybot /usr/local/bin/\n' +
      'sudo chmod +x /usr/local/bin/squishybot\n' +
      '```'

    await sendContainer(interaction, '🔁 Restart Instructions', text, 0x5865f2)
    return
  }
}

async function sendContainer(
  interaction: ChatInputCommandInteraction,
  title: string,
  body: string,
  color: number,
): Promise<void> {
  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${title}`)
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(body.slice(0, 3500))
    )

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    content: null,
  })
}
