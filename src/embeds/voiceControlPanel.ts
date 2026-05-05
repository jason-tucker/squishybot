import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type MessageActionRowComponentBuilder,
} from 'discord.js'
import type { AutoChannelRecord } from '../types/voice'
import { encodeVcId } from '../utils/customId'

export function buildControlPanelPayload(record: AutoChannelRecord, ownerTag: string, hostTags: string[]) {
  const statusLine = record.isLocked ? '🔒 Locked' : '🔓 Unlocked'
  const hostsLine = hostTags.length > 0 ? `**Hosts:** ${hostTags.join(', ')}` : '**Hosts:** none'
  const templateLabel = record.nameTemplate === 'counter' ? '🔢 counter' : record.nameTemplate === 'auto' ? '🎮 auto' : record.manualName ? '✏️ custom' : '🎮 auto'
  const nameLine = record.manualName ?? 'Auto-named channel'

  const container = new ContainerBuilder()
    .setAccentColor(record.isLocked ? 0xed4245 : 0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🔊 ${nameLine}\n**Owner:** <@${record.ownerUserId}>  •  ${statusLine}  •  ${templateLabel}\n${hostsLine}`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '_Use the buttons below to manage this voice channel.\nOnly the owner, hosts, and admins can make changes._'
      )
    )

  const vcId = record.voiceChannelId

  const row1 = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'rename'))
      .setLabel('Rename')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, record.isLocked ? 'unlock' : 'lock'))
      .setLabel(record.isLocked ? 'Unlock' : 'Lock')
      .setEmoji(record.isLocked ? '🔓' : '🔒')
      .setStyle(record.isLocked ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'add_host'))
      .setLabel('Add Host')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'remove_host'))
      .setLabel('Remove Host')
      .setEmoji('➖')
      .setStyle(ButtonStyle.Secondary),
  )

  const row2 = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeVcId(vcId, 'templates'))
      .setLabel('Templates')
      .setEmoji('📋')
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
    components: [container, row1, row2],
  }
}
