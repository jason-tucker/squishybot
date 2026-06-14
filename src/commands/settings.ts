import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type MessageActionRowComponentBuilder,
} from 'discord.js'
import { sep } from '../utils/cv2'
import { ensureProfile, formatBirthday } from '../services/userProfile'
import { resolvePrefs } from '../services/games'
import { appendPanelLink } from '../utils/panelLink'

export const data = new SlashCommandBuilder()
  .setName('settings')
  .setDescription('Edit your own SquishyBot settings — profile, birthday, game prefs')
  .setDMPermission(false)

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })
  await interaction.editReply(await renderSettingsHome(interaction) as any)
}

/**
 * Self-service landing page. Sudo-acts-on-behalf flows live under
 * `/sudo → Settings → User Profiles` and the **Manage User** context menu —
 * see CLAUDE.md for the two-surface convention.
 */
export async function renderSettingsHome(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<{ flags: number; components: any[] }> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const profile = await ensureProfile(interaction.guildId!, interaction.user.id)
  const prefs = await resolvePrefs(interaction.guild!, member)

  const display = profile?.displayName ?? member.displayName
  const birthday = formatBirthday(profile)
  const gamesOn = prefs.filter(p => p.wantsView || p.wantsPing).length
  const ringers = prefs.filter(p => p.wantsPing).length

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ⚙️ Your Settings`))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**Display name** — \`${display}\`\n` +
      `**Birthday** — ${birthday}\n` +
      `**Birthday pings** — ${profile?.birthdayPingsEnabled ? '🟢 enabled' : '🔴 disabled'}\n` +
      `**Games tracked** — ${gamesOn} (${ringers} with LFG pings)`
    ))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      'Pick what you want to edit. Everything here is **self-service** — only you can see this view.'
    ))

  const buttons = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('settings:profile')
      .setLabel('Profile & Birthday')
      .setEmoji('👤')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('settings:games')
      .setLabel('Game Prefs')
      .setEmoji('🎮')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('settings:staff_role')
      .setLabel('Staff Role')
      .setEmoji('🛡️')
      .setStyle(ButtonStyle.Primary),
  )

  appendPanelLink(container, '/me', 'Manage your settings on the website')

  return {
    flags: MessageFlags.IsComponentsV2 as number,
    components: [container, buttons],
  }
}

/** settings:home — back-button target from sub-editors. */
export async function handleSettingsHomeButton(interaction: ButtonInteraction): Promise<void> {
  await interaction.update(await renderSettingsHome(interaction) as any)
}

/** settings:profile — open the self-mode profile editor. */
export async function handleSettingsProfileButton(interaction: ButtonInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const { renderProfileEditor } = await import('../interactions/profileEditor')
  const payload = await renderProfileEditor(interaction.guildId!, interaction.user.id, member.displayName, 'self')
  await interaction.update(payload as any)
}

/** settings:games — open the self-mode game-prefs editor. */
export async function handleSettingsGamesButton(interaction: ButtonInteraction): Promise<void> {
  const { renderPrefsEditor } = await import('../interactions/gamesEditor')
  const payload = await renderPrefsEditor(interaction.guild!, interaction.user.id, 'self')
  await interaction.update(payload as any)
}
