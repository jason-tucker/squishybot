import type { StringSelectMenuInteraction } from 'discord.js'
import { decodeVcId } from '../../utils/customId'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq, sql } from 'drizzle-orm'
import { canControlChannel, isSudo, syncTextChannelPermissions } from '../../services/voice/permissions'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'

export async function handleVoiceControlSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const decoded = decodeVcId(interaction.customId)
  if (!decoded) return

  const { voiceChannelId, action } = decoded

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) {
    await interaction.reply({ content: '❌ This channel no longer exists.', ephemeral: true })
    return
  }

  const member = await interaction.guild!.members.fetch(interaction.user.id)
  if (!canControlChannel(member, record) && !isSudo(member)) {
    await interaction.reply({ content: '❌ You do not have permission.', ephemeral: true })
    return
  }

  const selectedValue = interaction.values[0]

  if (action === 'hosts') {
    // Value is "add:userId" or "remove:userId"
    const [op, userId] = selectedValue.split(':', 2)
    if ((op !== 'add' && op !== 'remove') || !userId) {
      await interaction.reply({ content: '❌ Invalid selection.', ephemeral: true })
      return
    }

    await interaction.deferUpdate()

    // Race-safe array mutation in SQL — concurrent host toggles on the same
    // record won't lose updates the way a JS read-modify-write would, since
    // each statement re-evaluates the array. RETURNING gives us the canonical
    // post-mutation row to render against.
    const expr = op === 'add'
      // de-dupe: union the current array with the user, then DISTINCT
      ? sql`(SELECT array_agg(DISTINCT x) FROM unnest(${autoChannels.hostUserIds} || ARRAY[${userId}]::text[]) AS x)`
      : sql`array_remove(${autoChannels.hostUserIds}, ${userId})`
    const [updatedRow] = await db.update(autoChannels)
      .set({ hostUserIds: expr })
      .where(eq(autoChannels.voiceChannelId, voiceChannelId))
      .returning()

    const updated = updatedRow ?? { ...record, hostUserIds: record.hostUserIds }

    // Cache.get over fetch — same pattern as the other handlers.
    const vc = interaction.guild!.channels.cache.get(record.voiceChannelId)
      ?? await interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null)
    const tc = interaction.guild!.channels.cache.get(record.textChannelId)
      ?? await interaction.guild!.channels.fetch(record.textChannelId).catch(() => null)
    if (vc?.isVoiceBased() && tc?.isTextBased()) {
      await syncTextChannelPermissions(tc as any, vc as any, updated, interaction.client.user!.id)
      // If the VC is hidden, hosts need an explicit view allow to find it from
      // the channel list. On removal, drop the overwrite so they go back to
      // @everyone-deny visibility.
      if (record.isHidden) {
        if (op === 'add') {
          await vc.permissionOverwrites.edit(userId, { ViewChannel: true }).catch(() => {})
        } else {
          await vc.permissionOverwrites.edit(userId, { ViewChannel: null }).catch(() => {})
        }
      }
    }
    await postOrUpdateControlPanel(interaction.client, updated)

    await interaction.editReply({
      content: op === 'add'
        ? `✅ <@${userId}> is now a host.`
        : `✅ <@${userId}> is no longer a host.`,
      components: [],
    })
    return
  }
}
