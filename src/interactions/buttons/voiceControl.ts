import {
  type ButtonInteraction,
  type GuildMember,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} from 'discord.js'
import { decodeVcId } from '../../utils/customId'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { canControlChannel, isOwner, isSudo } from '../../services/voice/permissions'
import { postOrUpdateControlPanel, buildPanelPayloadForRecord } from '../../services/voice/controlPanel'
import { buildOptionsPanelPayload, buildAutoNamePanelPayload } from '../../embeds/voiceControlPanel'
import { maybeRenameChannel } from '../../services/voice/autoRename'
import { decorateChannelName } from '../../services/voice/autoNaming'
import { randomTechName } from '../../utils/randomName'
import { deleteAutoChannel, deleteStaticText } from '../../services/voice/autoChannel'
import { env } from '../../config/env'
import {
  publish,
  voiceCh,
  type VoiceLockToggledEvent,
  type VoiceHiddenToggledEvent,
  type VoiceOwnerChangedEvent,
} from '../../services/eventBus'

type AutoChannelRecord = typeof autoChannels.$inferSelect

/**
 * Verifies that `member` may control `record`. If not, replies with an
 * ephemeral error and returns false. The caller should `return` immediately
 * when this returns false.
 */
async function requireControl(
  interaction: ButtonInteraction,
  member: GuildMember,
  record: AutoChannelRecord,
  message = '❌ You do not have permission.',
): Promise<boolean> {
  if (canControlChannel(member, record) || isSudo(member)) return true
  await interaction.reply({ content: message, ephemeral: true })
  return false
}

/**
 * Stricter guard for destructive actions (delete, hosts) — the acting owner
 * during a grace window is explicitly excluded. Only the real owner or sudo
 * can take these actions; this prevents an acting owner from deleting the
 * room or unseating the original owner before they get a chance to return.
 */
async function requireOwnerOrSudo(
  interaction: ButtonInteraction,
  member: GuildMember,
  record: AutoChannelRecord,
  message = '❌ The original host hasn\'t lost the room yet — only they (or a sudo) can do that.',
): Promise<boolean> {
  if (isOwner(member, record) || isSudo(member)) return true
  await interaction.reply({ content: message, ephemeral: true })
  return false
}

export async function handleVoiceControlButton(interaction: ButtonInteraction): Promise<void> {
  const decoded = decodeVcId(interaction.customId)
  if (!decoded) return

  const { voiceChannelId, action } = decoded

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) {
    await interaction.reply({ content: '❌ This channel no longer exists.', ephemeral: true })
    return
  }

  const member = await interaction.guild!.members.fetch(interaction.user.id)

  if (action === 'open_panel') {
    const payload = await buildPanelPayloadForRecord(interaction.client, record)
    await interaction.reply({
      ...payload,
      ephemeral: true,
    } as any)
    return
  }

  if (action === 'options') {
    if (!await requireControl(interaction, member, record)) return
    await interaction.reply({ ...buildOptionsPanelPayload(record), ephemeral: true } as any)
    return
  }

  // 'auto_name' is the current entry point; 'templates' is the legacy button on
  // older in-flight panels — both open the Auto Name sub-panel.
  if (action === 'auto_name' || action === 'templates') {
    if (!await requireControl(interaction, member, record)) return
    await interaction.reply({ ...buildAutoNamePanelPayload(record), ephemeral: true } as any)
    return
  }

  if (action === 'auto_on') {
    if (!await requireControl(interaction, member, record)) return
    await db.update(autoChannels)
      .set({ autoNameEnabled: true, nameTemplate: 'auto', manualName: null })
      .where(eq(autoChannels.voiceChannelId, voiceChannelId))
    const updated = { ...record, autoNameEnabled: true, nameTemplate: 'auto', manualName: null }
    await interaction.update({ ...buildAutoNamePanelPayload(updated), content: null } as any).catch(() => {})
    // Apply the smart name right away (no-op unless 2+ share a game; honours the
    // per-channel rename cooldown internally).
    await maybeRenameChannel(interaction.client, updated)
    await postOrUpdateControlPanel(interaction.client, updated)
    return
  }

  if (action === 'auto_off') {
    if (!await requireControl(interaction, member, record)) return
    await db.update(autoChannels)
      .set({ autoNameEnabled: false })
      .where(eq(autoChannels.voiceChannelId, voiceChannelId))
    const updated = { ...record, autoNameEnabled: false }
    await interaction.update({ ...buildAutoNamePanelPayload(updated), content: null } as any).catch(() => {})
    await postOrUpdateControlPanel(interaction.client, updated)
    return
  }

  if (action === 'randomize') {
    if (!await requireControl(interaction, member, record)) return
    const guild = interaction.guild!
    const vc = await guild.channels.fetch(record.voiceChannelId).catch(() => null)
    const baseName = randomTechName()
    const finalName = vc?.isVoiceBased() ? decorateChannelName(guild, baseName, vc.id) : baseName
    if (vc?.isVoiceBased()) {
      await vc.setName(finalName).catch(() => {})
      const tc = await guild.channels.fetch(record.textChannelId).catch(() => null)
      if (tc?.isTextBased()) {
        const textName = finalName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice-chat'
        await (tc as any).setName(textName).catch(() => {})
      }
    }
    // Freeze it: a randomized name behaves like a manual rename (auto-naming off).
    await db.update(autoChannels)
      .set({ manualName: baseName, autoNameEnabled: false, nameTemplate: null, fallbackName: baseName })
      .where(eq(autoChannels.voiceChannelId, voiceChannelId))
    const updated = { ...record, manualName: baseName, autoNameEnabled: false, nameTemplate: null, fallbackName: baseName }
    await interaction.update({ ...buildAutoNamePanelPayload(updated), content: null } as any).catch(() => {})
    await postOrUpdateControlPanel(interaction.client, updated)
    return
  }

  if (action === 'delete') {
    if (!await requireOwnerOrSudo(interaction, member, record, '❌ Only the original host (or a sudo) can delete this channel.')) return
    const isStatic = record.sourceHubId === 'static'
    const confirmLabel = isStatic ? 'Yes, close this session' : 'Yes, delete it'
    const confirmMsg = isStatic
      ? `⚠️ This is a **static voice channel** — it will stay, but the text chat and panel will be removed. Continue?`
      : `⚠️ Are you sure you want to delete **this auto voice channel**? This cannot be undone.`
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`vc:${voiceChannelId}:delete_confirm`)
        .setLabel(confirmLabel)
        .setStyle(ButtonStyle.Danger),
    )
    await interaction.reply({
      content: confirmMsg,
      components: [row],
      ephemeral: true,
    })
    return
  }

  if (action === 'delete_confirm') {
    if (!await requireOwnerOrSudo(interaction, member, record)) return
    await interaction.deferReply({ ephemeral: true })
    if (record.sourceHubId === 'static') {
      // Static VC: remove only the companion text channel; keep the voice channel.
      await deleteStaticText(interaction.client, record)
      await interaction.editReply({ content: '✅ Text channel closed. The voice channel was kept (static channel).' })
    } else {
      await deleteAutoChannel(interaction.client, record)
      await interaction.editReply({ content: '✅ Channel deleted.' })
    }
    return
  }

  if (action === 'rename') {
    if (!await requireControl(interaction, member, record, '❌ You do not have permission to rename this channel.')) return
    const modal = new ModalBuilder()
      .setCustomId(`vc:${voiceChannelId}:rename`)
      .setTitle('Rename Channel')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('new_name')
            .setLabel('New name (leave blank for auto-naming)')
            .setPlaceholder('Type a name to lock it in, or clear this to go back to Smart')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(false)
        )
      )
    await interaction.showModal(modal)
    return
  }

  if (action === 'lock' || action === 'unlock') {
    if (!await requireControl(interaction, member, record)) return

    const isLocked = action === 'lock'
    const vc = await interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null)
    if (vc?.isVoiceBased()) {
      if (isLocked) {
        await vc.permissionOverwrites.edit(interaction.guild!.roles.everyone, { Connect: false }).catch(() => {})
      } else {
        await vc.permissionOverwrites.edit(interaction.guild!.roles.everyone, { Connect: null }).catch(() => {})
      }
    }

    await db.update(autoChannels).set({ isLocked }).where(eq(autoChannels.voiceChannelId, voiceChannelId))
    const updated = { ...record, isLocked }

    void publish<VoiceLockToggledEvent>(voiceCh('lock_toggled'), {
      voiceChannelId, isLocked, ts: new Date().toISOString(),
    })

    // This toggle lives on the ephemeral ⚙️ Options panel — re-render it in
    // place so the button flips immediately, then refresh the public panel.
    await interaction.update({ ...buildOptionsPanelPayload(updated), content: null } as any).catch(() => {})
    await postOrUpdateControlPanel(interaction.client, updated)
    return
  }

  if (action === 'hide' || action === 'show') {
    if (!await requireControl(interaction, member, record)) return

    const isHidden = action === 'hide'
    const guild = interaction.guild!
    const vc = await guild.channels.fetch(record.voiceChannelId).catch(() => null)
    if (vc?.isVoiceBased()) {
      const everyone = guild.roles.everyone
      if (isHidden) {
        // Deny @everyone, then re-grant view to the people who need it so they
        // don't lose access to their own channel: bot (must keep managing it),
        // owner, current hosts, and sudo roles.
        await vc.permissionOverwrites.edit(everyone, { ViewChannel: false }).catch(() => {})
        const explicitAllows = new Set<string>([
          interaction.client.user!.id,
          record.ownerUserId,
          ...record.hostUserIds,
        ])
        for (const id of explicitAllows) {
          await vc.permissionOverwrites.edit(id, { ViewChannel: true }).catch(() => {})
        }
        for (const roleId of env.SUDO_ROLE_IDS) {
          await vc.permissionOverwrites.edit(roleId, { ViewChannel: true }).catch(() => {})
        }
      } else {
        // Restore @everyone visibility. Leave the explicit allows in place —
        // they're inert when @everyone is allowed and harmless to keep.
        await vc.permissionOverwrites.edit(everyone, { ViewChannel: null }).catch(() => {})
      }
    }

    await db.update(autoChannels).set({ isHidden }).where(eq(autoChannels.voiceChannelId, voiceChannelId))
    const updated = { ...record, isHidden }

    void publish<VoiceHiddenToggledEvent>(voiceCh('hidden_toggled'), {
      voiceChannelId, isHidden, ts: new Date().toISOString(),
    })

    await interaction.update({ ...buildOptionsPanelPayload(updated), content: null } as any).catch(() => {})
    await postOrUpdateControlPanel(interaction.client, updated)
    return
  }

  if (action === 'hosts') {
    if (!await requireOwnerOrSudo(interaction, member, record, '❌ Only the original host (or a sudo) can manage hosts.')) return
    const guild = interaction.guild!
    const vc = await guild.channels.fetch(record.voiceChannelId).catch(() => null)

    // One combined select. The emoji reflects each user's current rank in
    // this channel; clicking toggles host status (action shown in description).
    //   👑 = current host    (click to remove)
    //   🛡️ = sudo            (click to make a host)
    //   👤 = regular member  (click to make a host)
    const options: { label: string; value: string; description?: string; emoji?: string }[] = []

    // Current hosts first — clicking removes them
    for (const hostId of record.hostUserIds.slice(0, 24)) {
      const hostMember = await guild.members.fetch(hostId).catch(() => null)
      options.push({
        label: hostMember?.displayName ?? hostId,
        value: `remove:${hostId}`,
        description: 'Currently a host — click to remove',
        emoji: '👑',
      })
    }

    // Then VC members who aren't the owner and aren't hosts — clicking adds them
    if (vc?.isVoiceBased()) {
      const eligible = vc.members.filter(m => m.id !== record.ownerUserId && !record.hostUserIds.includes(m.id))
      for (const m of eligible.first(24 - options.length)) {
        const sudo = isSudo(m)
        options.push({
          label: m.displayName,
          value: `add:${m.id}`,
          description: sudo ? 'Sudo — click to make a host' : 'Member — click to make a host',
          emoji: sudo ? '🛡️' : '👤',
        })
      }
    }

    if (options.length === 0) {
      await interaction.reply({
        content: 'ℹ️ No hosts to remove and no eligible members to add. (Only members currently in the voice channel can be added as hosts.)',
        ephemeral: true,
      })
      return
    }

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`vc:${voiceChannelId}:hosts`)
        .setPlaceholder('Add or remove a host…')
        .addOptions(options)
    )
    await interaction.reply({
      content: '**Hosts** — 👑 host · 🛡️ sudo · 👤 member. Pick someone to toggle their host status.',
      components: [row],
      ephemeral: true,
    })
    return
  }

  if (action === 'claim') {
    const vc = await interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null)
    if (!vc?.isVoiceBased()) {
      await interaction.reply({ content: '❌ Voice channel not found.', ephemeral: true })
      return
    }
    const ownerPresent = vc.members.has(record.ownerUserId)
    if (ownerPresent && !isSudo(member)) {
      await interaction.reply({ content: '❌ The owner is still in the channel. You can only claim when they\'ve left.', ephemeral: true })
      return
    }
    // Active grace — the original owner has a reserved seat until grace expires.
    // Acting owner is in place; nobody else can claim until the timer runs out.
    const inGrace = record.actingOwnerUserId && record.ownerGraceExpiresAt && record.ownerGraceExpiresAt.getTime() > Date.now()
    if (inGrace && !isSudo(member)) {
      const returnBySec = Math.floor(record.ownerGraceExpiresAt!.getTime() / 1000)
      await interaction.reply({ content: `❌ The original host has a grace window — they can return until <t:${returnBySec}:R>. After that the acting host (<@${record.actingOwnerUserId}>) becomes the permanent owner.`, ephemeral: true })
      return
    }
    if (!vc.members.has(member.id) && !isSudo(member)) {
      await interaction.reply({ content: '❌ You need to be in the voice channel to claim it.', ephemeral: true })
      return
    }
    // CAS-style update: only succeeds if owner_user_id is still what we read.
    // Two near-simultaneous Claim clicks both pass the "owner present" check
    // above; without this guard both UPDATEs would land and the second would
    // silently overwrite the first. With it, the second sees 0 rows and we
    // bail with a clean message.
    const claimed = await db.update(autoChannels)
      .set({
        ownerUserId: member.id,
        hostUserIds: sql`array_remove(${autoChannels.hostUserIds}, ${member.id})`,
      })
      .where(and(
        eq(autoChannels.voiceChannelId, voiceChannelId),
        eq(autoChannels.ownerUserId, record.ownerUserId),
      ))
      .returning()

    if (claimed.length === 0) {
      await interaction.reply({ content: '❌ Someone else just claimed it. Refresh the panel.', ephemeral: true })
      return
    }
    const updated = claimed[0]

    void publish<VoiceOwnerChangedEvent>(voiceCh('owner_changed'), {
      voiceChannelId,
      oldOwnerUserId: record.ownerUserId,
      newOwnerUserId: member.id,
      ts: new Date().toISOString(),
    })

    // While hidden the new owner needs an explicit view-channel allow so
    // they don't lose track of their own VC after leaving voice.
    if (record.isHidden) {
      await vc.permissionOverwrites.edit(member.id, { ViewChannel: true }).catch(() => {})
    }

    // Claim lives on the ⚙️ Options panel — re-render it, then refresh the
    // public panel so the new owner shows everywhere.
    await interaction.update({ ...buildOptionsPanelPayload(updated), content: null } as any).catch(() => {})
    await postOrUpdateControlPanel(interaction.client, updated)
    return
  }
}
