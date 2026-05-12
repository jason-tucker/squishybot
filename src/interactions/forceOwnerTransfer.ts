/**
 * Sudo "Force owner transfer" two-step flow:
 *
 *   /sudo → Force owner transfer
 *     → StringSelect `sudo:force_owner:channel_pick` (pick auto-channel)
 *     → UserSelect   `sudo:force_owner:user_pick:{channelId}` (pick new owner)
 *     → DB update + permission resync + panel refresh
 *
 * Bypasses claim, grace, and ownership rules. Cancels any active grace
 * window — we're overriding it, not respecting it.
 */
import {
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  type MessageActionRowComponentBuilder,
  MessageFlags,
  TextDisplayBuilder,
  UserSelectMenuBuilder,
} from 'discord.js'
import { db } from '../db/client'
import { autoChannels } from '../db/schema'
import { eq } from 'drizzle-orm'
import { requireSudo } from '../services/voice/permissions'
import { sep } from '../utils/cv2'
import { logger } from '../services/logger'

export async function handleForceOwnerChannelPick(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  const channelId = interaction.values[0]
  if (!channelId) return

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, channelId))
  if (!record) {
    await interaction.update({ content: '❌ Channel no longer exists.', components: [] } as any).catch(() => {})
    return
  }

  const container = new ContainerBuilder()
    .setAccentColor(0xfee75c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 👤 Force owner transfer'))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `Channel: **${record.manualName ?? record.fallbackName ?? `vc=${record.voiceChannelId.slice(-6)}`}**\n` +
      `Current owner: <@${record.ownerUserId}>\n\n` +
      '_Pick the new owner. The transfer is **immediate** — any active grace window is cancelled and the new owner gets full panel access._'
    ))

  const picker = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`sudo:force_owner:user_pick:${channelId}`)
      .setPlaceholder('Pick the new owner…')
      .setMinValues(1).setMaxValues(1),
  )
  const back = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:home').setLabel('Back to /sudo').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
  )
  await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [container, picker, back] } as any)
}

export async function handleForceOwnerUserPick(interaction: UserSelectMenuInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  const channelId = interaction.customId.slice('sudo:force_owner:user_pick:'.length)
  const newOwnerId = interaction.values[0]
  if (!channelId || !newOwnerId) return

  await interaction.deferUpdate()

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, channelId))
  if (!record) {
    await interaction.editReply({ content: '❌ Channel no longer exists.', components: [] } as any).catch(() => {})
    return
  }

  if (record.ownerUserId === newOwnerId) {
    await interaction.editReply({ content: `ℹ️ <@${newOwnerId}> is already the owner. Nothing to do.`, components: [] } as any).catch(() => {})
    return
  }

  const { cancelGraceTimer } = await import('../services/voice/ownerGrace')
  cancelGraceTimer(channelId)

  // New owner shouldn't carry over as a host once they're the actual owner.
  const newHosts = record.hostUserIds.filter(id => id !== newOwnerId)

  const [updated] = await db.update(autoChannels)
    .set({
      ownerUserId: newOwnerId,
      hostUserIds: newHosts,
      actingOwnerUserId: null,
      ownerGraceExpiresAt: null,
    })
    .where(eq(autoChannels.voiceChannelId, channelId))
    .returning()

  // Re-sync text-channel permissions so the new owner has the right overwrite.
  // Best-effort — if the channels are missing we still report success on the DB row.
  try {
    const guild = interaction.guild!
    const vc = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null)
    const tc = guild.channels.cache.get(record.textChannelId) ?? await guild.channels.fetch(record.textChannelId).catch(() => null)
    if (vc?.isVoiceBased() && tc?.isTextBased()) {
      const { syncTextChannelPermissions } = await import('../services/voice/permissions')
      await syncTextChannelPermissions(tc as any, vc as any, updated, interaction.client.user!.id)
    }
  } catch (err) {
    logger.warn(`force_owner: permission resync failed for vc=${channelId}: ${(err as Error).message}`)
  }

  const { postOrUpdateControlPanel } = await import('../services/voice/controlPanel')
  await postOrUpdateControlPanel(interaction.client, updated).catch(() => {})

  logger.info(`Force owner transfer: vc=${channelId} ${record.ownerUserId} → ${newOwnerId} (by sudo ${interaction.user.id})`)

  const container = new ContainerBuilder()
    .setAccentColor(0x57f287)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## ✅ Owner transferred'))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**Channel:** <#${channelId}>\n` +
      `**Previous owner:** <@${record.ownerUserId}>\n` +
      `**New owner:** <@${newOwnerId}>`
    ))
  const back = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:home').setLabel('Back to /sudo').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
  )
  await interaction.editReply({ flags: MessageFlags.IsComponentsV2, components: [container, back] } as any)
}
