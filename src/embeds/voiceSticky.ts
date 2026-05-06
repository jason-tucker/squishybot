import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} from 'discord.js'
import { encodeVcId } from '../utils/customId'

const SUPPRESS_NOTIFICATIONS = 1 << 12 // MessageFlags.SuppressNotifications

export function buildStickyPayload(voiceChannelId: string) {
  const container = new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# This channel (and <#${voiceChannelId}>) will be deleted, don't intend for things to stay here.`
      )
    )

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeVcId(voiceChannelId, 'open_panel'))
      .setLabel('Open Panel')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Primary)
  )

  return {
    flags: ((MessageFlags.IsComponentsV2 as number) | SUPPRESS_NOTIFICATIONS),
    components: [container, row],
  }
}
