import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js'
import { encodeVcId } from '../utils/customId'

const SUPPRESS_NOTIFICATIONS = 1 << 12

/**
 * Tiny non-CV2 sticky — Open Panel + Log buttons, posted silently. Sits at the
 * bottom of the auto channel's text channel and is reposted whenever new
 * messages would push it up. The Log button opens an ephemeral activity log
 * that anyone in the channel can view. Channel-deletion warning lives in the
 * control panel header instead.
 */
export function buildStickyPayload(voiceChannelId: string) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeVcId(voiceChannelId, 'open_panel'))
      .setLabel('Open Panel')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeVcId(voiceChannelId, 'log'))
      .setLabel('Log')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary),
  )

  return {
    flags: SUPPRESS_NOTIFICATIONS,
    components: [row],
  }
}
