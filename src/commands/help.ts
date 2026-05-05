import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} from 'discord.js'
import { isSudo } from '../services/voice/permissions'

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show available SquishyBot commands')
  .setDMPermission(false)

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const sudo = isSudo(member)

  const everyoneSection =
    '### 👥 Everyone\n' +
    '`/help` — show this list\n' +
    '`/squishy status` — bot uptime + active channel count\n' +
    '`/staff request` — request to join the server staff team'

  const voiceSection =
    '### 🔊 Voice channels\n' +
    'Join a **hub** voice channel and SquishyBot will turn it into your own room.\n' +
    'A private text channel appears with a **control panel** for rename, lock, hosts, and delete.\n\n' +
    '`/voice panel` — re-open the control panel for your active voice channel\n' +
    '`/voice claim` — claim ownership when the previous owner leaves\n' +
    '`/voice delete` — delete your auto voice channel'

  const sudoSection =
    '### 🛡️ Sudo / Admin\n' +
    '`/squishy repair` — manually run the channel reconciler\n' +
    '`/sudo channels` — list active auto voice channels\n' +
    '`/sudo hubs` — list managed hub channels\n' +
    '`/sudo cleanup` — force cleanup of stale/empty channels\n' +
    '`/sudo approvals` — view pending staff approvals\n' +
    '`/sudo restart` — instructions to restart the bot from the terminal'

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('## 🤖 SquishyBot Commands')
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(everyoneSection)
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(voiceSection)
    )

  if (sudo) {
    container
      .addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(sudoSection)
      )
  }

  await interaction.editReply({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    content: null,
  })
}
