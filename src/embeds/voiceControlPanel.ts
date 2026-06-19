import {
  ContainerBuilder,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type MessageActionRowComponentBuilder,
} from 'discord.js'
import type { AutoChannelRecord } from '../types/voice'
import { encodeVcId } from '../utils/customId'
import type { MemberJoin } from '../services/voice/voiceMembers'

const SUPPRESS_NOTIFICATIONS = 1 << 12

export interface MemberPresenceInfo {
  userId: string
  joinedAt: Date
  /** Discord rich-presence "Playing X" activity name, if any. */
  game: string | null
  /** Rich-presence details line (e.g. "Match in progress"). */
  details: string | null
  /** Rich-presence state line (e.g. "Quick Play"). */
  state: string | null
  /** Rich-presence party size, when reported. */
  partySize: [number, number] | null
}

export interface PanelNameContext {
  /** The live Discord channel name (may lag the DB during throttle). */
  currentName: string
  /** Human-readable explanation of why the channel is named that way. */
  reason: string
}

/**
 * Compact first-message panel: short status header + member list with relative
 * join timestamps + action buttons. Stays as the channel's first/top message
 * (the sticky lives separately at the bottom). Re-rendered on voice-state
 * changes so the member list and ownership stay current.
 */
export function buildControlPanelPayload(
  record: AutoChannelRecord,
  ownerTag: string,
  hostTags: string[],
  members: MemberPresenceInfo[],
  nameContext?: PanelNameContext | null,
) {
  const createdSec = Math.floor(record.createdAt.getTime() / 1000)
  const headerLines: string[] = []
  const inGrace = record.actingOwnerUserId && record.ownerGraceExpiresAt && record.ownerGraceExpiresAt.getTime() > Date.now()
  if (inGrace) {
    const returnBySec = Math.floor(record.ownerGraceExpiresAt!.getTime() / 1000)
    headerLines.push(`🔊 host <@${record.ownerUserId}> _(away — returns by <t:${returnBySec}:R>)_ · created <t:${createdSec}:R>`)
    headerLines.push(`🎙️ acting host <@${record.actingOwnerUserId}>`)
  } else {
    headerLines.push(`🔊 host <@${record.ownerUserId}> · created <t:${createdSec}:R>`)
  }
  if (hostTags.length > 0) {
    headerLines.push(`👑 ${hostTags.join(', ')}`)
  }
  if (record.isLocked || record.isHidden) {
    const flags: string[] = []
    if (record.isLocked) flags.push('🔒 locked')
    if (record.isHidden) flags.push('🙈 hidden')
    headerLines.push(flags.join(' · '))
  }

  if (members.length > 0) {
    const sorted = [...members].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
    headerLines.push('👥 In channel')
    for (const m of sorted) {
      const joinedSec = Math.floor(m.joinedAt.getTime() / 1000)
      headerLines.push(`• <@${m.userId}> joined <t:${joinedSec}:R>`)
      if (m.game) {
        const bits: string[] = [`🎮 ${m.game}`]
        if (m.details) bits.push(m.details)
        if (m.state) bits.push(m.state)
        if (m.partySize) bits.push(`🎉 ${m.partySize[0]}/${m.partySize[1]}`)
        headerLines.push(`   ↳ ${bits.join(' · ')}`)
      }
    }
  }

  if (nameContext) {
    headerLines.push('')
    headerLines.push(`📛 **Current name:** \`${nameContext.currentName}\``)
    headerLines.push(`💡 ${nameContext.reason}`)
  }

  // Hard cap on text content. CV2 TextDisplay accepts a lot but very large
  // member rosters with rich-presence sub-lines can push past 4000 chars
  // (Discord rejects the whole edit). 3500 leaves headroom for future fields.
  const headerText = headerLines.join('\n').slice(0, 3500)
  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(headerText),
    )

  const vcId = record.voiceChannelId

  // Deliberately just two buttons. Everything else lives behind ⚙️ Options so
  // the channel's top message stays clean. The bottom 📋 Open Panel sticky is
  // the way to (re)open a private copy when chat buries this one.
  //   ✏️ Rename  — set a custom name (blank reverts to Smart auto-naming)
  //   ⚙️ Options — lock / hide / hosts / claim / auto-name / delete
  const actionRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'rename'))
      .setLabel('Rename')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'options'))
      .setLabel('Options')
      .setEmoji('⚙️')
      .setStyle(ButtonStyle.Secondary),
  )

  return {
    flags: ((MessageFlags.IsComponentsV2 as number) | SUPPRESS_NOTIFICATIONS),
    components: [container, actionRow],
  }
}

/**
 * Ephemeral ⚙️ Options sub-panel — the home for everything that used to clutter
 * the main panel: lock/hide toggles (label + color reflect current state),
 * Hosts, Claim, Auto Name, and Delete. Opened from the main panel's Options
 * button; its toggle buttons re-render this same ephemeral message in place
 * while also refreshing the public panel.
 */
export function buildOptionsPanelPayload(record: AutoChannelRecord) {
  const vcId = record.voiceChannelId
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '### ⚙️ Channel Options\n' +
      `🔒 **${record.isLocked ? 'Locked' : 'Unlocked'}** · ` +
      `${record.isHidden ? '🙈 **Hidden**' : '👁️ **Visible**'} · ` +
      `🏷️ Auto-naming **${record.autoNameEnabled ? 'On' : 'Off'}**`,
    ),
  )

  // Row 1 — toggles (label + color show the current state; clicking flips it).
  const toggleRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, record.isLocked ? 'unlock' : 'lock'))
      .setLabel(record.isLocked ? 'Locked' : 'Unlocked')
      .setEmoji(record.isLocked ? '🔒' : '🔓')
      .setStyle(record.isLocked ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, record.isHidden ? 'show' : 'hide'))
      .setLabel(record.isHidden ? 'Hidden' : 'Visible')
      .setEmoji(record.isHidden ? '🙈' : '👁️')
      .setStyle(record.isHidden ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'auto_name'))
      .setLabel('Auto Name')
      .setEmoji('🏷️')
      .setStyle(ButtonStyle.Secondary),
  )

  // Row 2 — ownership + destructive.
  const ownerRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'hosts'))
      .setLabel('Hosts')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'claim'))
      .setLabel('Claim')
      .setEmoji('👤')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'delete'))
      .setLabel('Delete')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
  )

  return {
    flags: MessageFlags.IsComponentsV2 as number,
    components: [container, toggleRow, ownerRow],
  }
}

/**
 * Ephemeral 🏷️ Auto Name sub-panel. Two controls: a toggle between **Smart**
 * (rename the room after whatever game 2+ people share) and **Off** (freeze the
 * name), plus a one-shot **🎲 Randomize** button. A manual Rename always wins
 * and sticks until you rename to blank.
 */
export function buildAutoNamePanelPayload(record: AutoChannelRecord) {
  const vcId = record.voiceChannelId
  const on = record.autoNameEnabled
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '### 🏷️ Auto Name\n' +
      `Currently **${on ? 'On — Smart' : 'Off'}**.\n\n` +
      '• **Smart** renames the room to whatever game **2 or more** people are playing.\n' +
      '• **Off** leaves the name exactly as it is.\n' +
      '• **🎲 Randomize** drops a fun random name on the room right now (and freezes it).\n\n' +
      '_Tip: a custom **Rename** always wins — it stays put no matter what anyone plays. Rename to blank to hand control back to Smart._',
    ),
  )
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, on ? 'auto_off' : 'auto_on'))
      .setLabel(on ? 'Turn Off' : 'Turn On (Smart)')
      .setEmoji(on ? '🚫' : '✨')
      .setStyle(on ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'randomize'))
      .setLabel('Randomize')
      .setEmoji('🎲')
      .setStyle(ButtonStyle.Primary),
  )
  return {
    flags: MessageFlags.IsComponentsV2 as number,
    components: [container, row],
  }
}

// Re-export the underlying join-row type for callers that don't need presence.
export type { MemberJoin } from '../services/voice/voiceMembers'
