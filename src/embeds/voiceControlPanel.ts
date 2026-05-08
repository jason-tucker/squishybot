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
  members: MemberJoin[],
) {
  const createdSec = Math.floor(record.createdAt.getTime() / 1000)
  const headerLines: string[] = []
  headerLines.push(`🔊 host <@${record.ownerUserId}> · created <t:${createdSec}:R>`)
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
    }
  }

  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(headerLines.join('\n')),
    )

  const vcId = record.voiceChannelId

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
