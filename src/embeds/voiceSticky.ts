import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js'
import { encodeVcId } from '../utils/customId'

const SUPPRESS_NOTIFICATIONS = 1 << 12

/**
 * Tiny non-CV2 sticky — just the Open Panel button, posted silently. Sits at
 * the bottom of the auto channel's text channel and is reposted whenever new
 * messages would push it up. Channel-deletion warning lives in the control
 * panel header instead.
 */
export function buildStickyPayload(voiceChannelId: string) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeVcId(voiceChannelId, 'open_panel'))
      .setLabel('Open Panel')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Primary),
  )

  return {
    flags: SUPPRESS_NOTIFICATIONS,
    components: [row],
  }
}
