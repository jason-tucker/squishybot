import {
  type StringSelectMenuInteraction,
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js'
import { isSudo } from '../../services/voice/permissions'
import { sep } from '../../utils/cv2'

export async function handleSquishyPanelSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id)
  const section = interaction.values[0]

  if (section === 'voice') {
    const container = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🔊 Auto Voice Channels'))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        '**How it works:**\n' +
        '1. Join a **hub** voice channel (look for ➕ in the voice list)\n' +
        '2. The hub converts into **your personal channel** — you stay in it\n' +
        '3. A new hub is created instantly to replace it\n' +
        '4. A private **text channel** appears, only visible to people in your voice channel\n' +
        '5. A **control panel** posts in that text channel with all your options\n' +
        '6. When everyone leaves, both channels delete themselves after 30 seconds'
      ))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        '**Your channel, your rules:**\n' +
        '- **Rename** it anything you want\n' +
        '- **Lock** it so only invited people can join\n' +
        '- **Add hosts** who can also manage the channel\n' +
        '- **Claim** it if the original owner leaves\n\n' +
        'Use **/voice** while in your channel to open the control panel from anywhere.'
      ))

    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('squishy:back').setLabel('Back').setStyle(ButtonStyle.Secondary)
    )
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [container, backRow] } as any)

  } else if (section === 'staff') {
    const container = new ContainerBuilder()
      .setAccentColor(0x57f287)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 📝 Staff Role Requests'))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        'Want to join the server staff team? Submit a request and an admin will review it.\n\n' +
        '**What you\'ll fill out:**\n' +
        '- Category (ITSRI Staff, Friend of ITSRI, etc.)\n' +
        '- Department (Help Desk, Sales, Leadership, etc.)\n' +
        '- Tier (Tier 1 / 2 / 3 / N/A)\n' +
        '- Your real or preferred name\n' +
        '- A short reason for your request\n\n' +
        'Your request goes to an admin for approval. You\'ll get a DM when it\'s reviewed.'
      ))

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('open_staff_request').setLabel('Submit Request').setEmoji('📝').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('squishy:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
    )
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [container, row] } as any)

  } else if (section === 'panel') {
    const container = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🎛️ Voice Control Panel'))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        'The control panel appears automatically in your private text channel when you create a voice channel.\n\n' +
        '**Panel buttons:**\n' +
        '✏️ **Rename** — set a custom channel name via a popup form\n' +
        '🔒 **Lock / Unlock** — prevent new people from joining\n' +
        '👑 **Hosts** — one panel to add or remove hosts (members already in the VC)\n' +
        '📋 **Templates** — Auto (follows your game) / Counter ([x/y]) / Comp 5-stack / Tryhard / Chill\n' +
        '👤 **Claim** — become the owner if the previous owner left\n' +
        '🗑️ **Delete** — immediately delete the channel and text channel\n\n' +
        'A silent **📋 Open Panel** sticky stays at the bottom of the text channel so the panel ' +
        'is always one click away. Use **/voice** from any channel for an ephemeral copy too.'
      ))

    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('squishy:back').setLabel('Back').setStyle(ButtonStyle.Secondary)
    )
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [container, backRow] } as any)

  } else if (section === 'report') {
    const container = new ContainerBuilder()
      .setAccentColor(0xfee75c)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🐛 Bug & Feature Reports'))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        'Use **/report** to send a bug report or feature request straight to the bot owner. ' +
        'You\'ll fill out a short form:\n\n' +
        '- **Title** — one-line summary\n' +
        '- **Type** — bug / feature / question\n' +
        '- **Description** — what happened, what you expected\n' +
        '- **Steps to reproduce** (optional)\n\n' +
        'Your report is **not** posted publicly. The bot DMs the owner with the contents and ' +
        'four review buttons (Approve+Notify / Approve Silent / Reject+Notify / Reject Silent). ' +
        'If approved, a GitHub issue is filed and you may get a DM with the link. ' +
        'If rejected, you may get a DM letting you know.'
      ))

    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('squishy:back').setLabel('Back').setStyle(ButtonStyle.Secondary)
    )
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [container, backRow] } as any)

  } else if (section === 'admin' && isSudo(member)) {
    const container = new ContainerBuilder()
      .setAccentColor(0xed4245)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🛡️ Admin Tools'))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        '**/sudo** — open the admin panel (select menu with all options)\n\n' +
        '**Admin select menu options:**\n' +
        '🔊 Active voice channels — list all current auto channels\n' +
        '🪐 Hub channels — list all registered hubs\n' +
        '🧹 Force cleanup — delete empty or orphaned channels\n' +
        '📥 Pending approvals — view pending staff requests\n' +
        '🔧 Run reconciler — repair channels on restart\n' +
        '🔁 Restart instructions — terminal commands\n\n' +
        '**Right-click any user → Apps → Manage User** to:\n' +
        '- View their roles, voice status, and owned channels\n' +
        '- Disconnect them from voice\n' +
        '- View their staff request history'
      ))

    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('squishy:back').setLabel('Back').setStyle(ButtonStyle.Secondary)
    )
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [container, backRow] } as any)
  }
}
