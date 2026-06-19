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

export async function handleHelpPanelSelect(interaction: StringSelectMenuInteraction): Promise<void> {
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
      new ButtonBuilder().setCustomId('help:back').setLabel('Back').setStyle(ButtonStyle.Secondary)
    )
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [container, backRow] } as any)

  } else if (section === 'games') {
    const container = new ContainerBuilder()
      .setAccentColor(0x9b59b6)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🎮 Games & LFG'))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        '**/games** opens a panel listing every game on this server. Each row shows ' +
        'how many people are signed up. Pick a game from the dropdown to:\n\n' +
        '• Toggle **View access** — gives you the game role so its channel shows up for you\n' +
        '• Toggle **LFG pings** — gives you the ping role so /play notifies you\n\n' +
        '**/play <game>** posts a "🎮 I want to play!" button in the game\'s channel and ' +
        'pings whoever has LFG on. Other people click the button to join you. There\'s a ' +
        'short cooldown so the channel doesn\'t get spammed.\n\n' +
        '_If you already had a game role from before the bot was set up, /games will ' +
        'show that and let you make it explicit (or remove it)._'
      ))
    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('help:back').setLabel('Back').setStyle(ButtonStyle.Secondary)
    )
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [container, backRow] } as any)

  } else if (section === 'gamenight') {
    const container = new ContainerBuilder()
      .setAccentColor(0xfee75c)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🎲 Game Night'))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        'A **sudo** runs `/sudo → Game Night → Schedule` to post an announcement. ' +
        'It pings the game\'s ping role, lists who\'s the host, and shows the date/time. ' +
        'Below the announcement you get five buttons:'
      ))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        '**RSVP — pick exactly one. Click again to clear.**\n' +
        '✅ **Joining** — count me in.\n' +
        '🤔 **Might join** — tentative.\n' +
        '❌ **Not joining** — opting out so the host has a clean head-count.\n\n' +
        '**Ownership — does the game cost money? Tells the host who needs a key/copy.**\n' +
        '👍 **I own it** — already have a copy / no help needed.\n' +
        '🛒 **I don\'t own it** — flag yourself as needing it (the host can gift, share, or pick a different game).\n\n' +
        '**Cancel — host or sudo only.**\n' +
        '✖️ **Cancel** — calls the night off; everyone who RSVPed gets a notice in-thread.'
      ))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        '_Your RSVP and ownership choice update the announcement live, so the host always sees the current count._'
      ))

    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('help:back').setLabel('Back').setStyle(ButtonStyle.Secondary)
    )
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [container, backRow] } as any)

  } else if (section === 'staff') {
    const container = new ContainerBuilder()
      .setAccentColor(0x57f287)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 📝 Staff Role Requests'))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        'Want to join the server staff team? Open **/settings → Staff Role** to request one. ' +
        'An admin reviews each request.\n\n' +
        '**How it works:**\n' +
        '1. Run **/settings** and click **Staff Role** — you\'ll see the 7 staff roles ' +
        '(Tier 1 / Tier 2 / Tier 3 / Help Desk / Onsites / Security / Leadership) and their status.\n' +
        '2. Click **Request a Staff Role**, pick the one you want, fill out the short form ' +
        '(real / preferred name and reason — both optional).\n' +
        '3. Submit — an admin gets pinged in the staff approvals thread.\n' +
        '4. On **Approve**, the bot adds the role to you automatically and DMs you. On **Deny**, ' +
        'you also get a DM.\n\n' +
        '_/settings → Staff Role is also where you remove a staff role you no longer want._'
      ))

    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('help:back').setLabel('Back').setStyle(ButtonStyle.Secondary)
    )
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [container, backRow] } as any)

  } else if (section === 'panel') {
    const container = new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🎛️ Voice Control Panel'))
      .addSeparatorComponents(sep())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        'The control panel posts **silently** in your private text channel as soon as the channel is ' +
        'created — no notification fires. It stays the top message in the channel and re-renders on ' +
        'every voice-state change so the **In channel** member list (with each person\'s join time and ' +
        'current rich-presence game) is always current. With **Smart** auto-naming on, the room is named ' +
        'after whatever game **2 or more** people are playing.\n\n' +
        '**Panel buttons** (just two — everything else lives under Options):\n' +
        '✏️ **Rename** — set a custom name via a popup. A custom name **sticks** no matter what anyone plays. Leave the box blank to hand control back to Smart auto-naming.\n' +
        '⚙️ **Options** — opens a private menu with everything else:\n' +
        '   • 🔒/🔓 **Locked / Unlocked** and 🙈/👁️ **Hidden / Visible** — toggles (label + colour show the current state)\n' +
        '   • 👑 **Hosts** — add/remove hosts (each shows their rank: 👑 host · 🛡️ sudo · 👤 member)\n' +
        '   • 🏷️ **Auto Name** — switch between **Smart** (game-driven) and **Off**, or hit **🎲 Randomize** for a fun random name that freezes in place\n' +
        '   • 👤 **Claim** — become the owner if the previous owner left\n' +
        '   • 🗑️ **Delete** — immediately delete the voice + text channels\n\n' +
        'A silent **📋 Open Panel** sticky stays at the bottom of the text channel so the panel ' +
        'is always one click away. Use **/voice** from any channel for an ephemeral copy too.'
      ))

    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('help:back').setLabel('Back').setStyle(ButtonStyle.Secondary)
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
      new ButtonBuilder().setCustomId('help:back').setLabel('Back').setStyle(ButtonStyle.Secondary)
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
        '**Right-click any user → Apps → Manage** to:\n' +
        '- View their roles, voice status, and owned channels\n' +
        '- Edit their profile or game prefs\n' +
        '- Disconnect them from voice\n' +
        '- View their staff request history'
      ))

    const backRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('help:back').setLabel('Back').setStyle(ButtonStyle.Secondary)
    )
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [container, backRow] } as any)
  }
}
