import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} from 'discord.js'
import { isSudo } from '../services/voice/permissions'
import { sep } from '../utils/cv2'

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
    '`/squishy` — bot status + feature menu (voice / panel / staff requests / reports)\n' +
    '`/staff request` — request to join the server staff team\n' +
    '`/report` — file a bug or feature request (owner reviews via DM, then files a GitHub issue)'

  const voiceSection =
    '### 🔊 Voice channels\n' +
    'Join a **hub** voice channel and SquishyBot will turn it into your own room.\n' +
    'A private text channel appears with a **control panel** for rename, lock, hosts, templates, claim, and delete.\n\n' +
    '`/voice` — open an ephemeral copy of the control panel for the auto channel you\'re in\n' +
    '_(All voice controls live on the panel itself — there are no sub-commands.)_'

  const sudoSection =
    '### 🛡️ Sudo / Admin\n' +
    '`/sudo` — opens the admin select menu:\n' +
    '• **Settings** — runtime config (sudo users, channels, voice, feature flags) backed by `bot_settings` / `sudo_users`\n' +
    '• Active voice channels · Hub channels · Force cleanup · Pending approvals · Run reconciler · Restart instructions\n\n' +
    'Right-click a member → **Manage User** — roles, voice status, disconnect, staff history'

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('## 🤖 SquishyBot Commands')
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(everyoneSection)
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(voiceSection)
    )

  if (sudo) {
    container
      .addSeparatorComponents(sep())
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
