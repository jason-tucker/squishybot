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
import { sep } from '../utils/cv2'

export function buildControlPanelPayload(record: AutoChannelRecord, ownerTag: string, hostTags: string[]) {
  const lockBadge = record.isLocked ? '🔒 Locked' : '🔓 Unlocked'
  const visibilityBadge = record.isHidden ? '🙈 Hidden' : '👁️ Visible'
  const hostsLine = hostTags.length > 0 ? `**Hosts:** ${hostTags.join(', ')}` : '**Hosts:** none'
  const templateLabel = record.nameTemplate === 'counter' ? '🔢 counter' : record.nameTemplate === 'auto' ? '🎮 auto' : record.manualName ? '✏️ custom' : '🎮 auto'
  const nameLine = record.manualName ?? 'Auto-named channel'

  // Accent: red while locked, grey while hidden-but-unlocked, blue otherwise.
  const accent = record.isLocked ? 0xed4245 : record.isHidden ? 0x808080 : 0x5865f2

  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🔊 ${nameLine}\n**Owner:** <@${record.ownerUserId}>  •  ${lockBadge}  •  ${visibilityBadge}  •  ${templateLabel}\n${hostsLine}`
      )
    )
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '_Use the buttons below to manage this voice channel.\nOnly the owner, hosts, and admins can make changes._'
      )
    )

  const vcId = record.voiceChannelId

  // Customization row — name + people + presets.
  const customizeRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'rename'))
      .setLabel('Rename')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'hosts'))
      .setLabel('Hosts')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'templates'))
      .setLabel('Templates')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
  )

  // State row — lock and hide are independent toggles, paired so they're
  // always visible together. Discord clients used to crowd the hide button
  // off-screen when these were mixed in with rename/hosts at 4-per-row.
  const stateRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, record.isLocked ? 'unlock' : 'lock'))
      .setLabel(record.isLocked ? 'Unlock' : 'Lock')
      .setEmoji(record.isLocked ? '🔓' : '🔒')
      .setStyle(record.isLocked ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, record.isHidden ? 'show' : 'hide'))
      .setLabel(record.isHidden ? 'Show' : 'Hide')
      .setEmoji(record.isHidden ? '👁️' : '🙈')
      .setStyle(record.isHidden ? ButtonStyle.Success : ButtonStyle.Primary),
  )

  // Ownership / destructive row.
  const ownerRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
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
    components: [container, customizeRow, stateRow, ownerRow],
  }
}
