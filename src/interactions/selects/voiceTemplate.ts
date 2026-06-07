import { type StringSelectMenuInteraction, ActivityType } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { canControlChannel, isSudo } from '../../services/voice/permissions'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'
import { computeAutoName, decorateChannelName, ALL_TEMPLATES, TEMPLATE_LABELS, type NameTemplate } from '../../services/voice/autoNaming'
import { decodeVcId } from '../../utils/customId'
import { randomTechName } from '../../utils/randomName'

export async function handleVoiceTemplateSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const decoded = decodeVcId(interaction.customId)
  if (!decoded) return

  const { voiceChannelId } = decoded
  const choice = interaction.values[0]

  const [record] = await db.select().from(autoChannels).where(eq(autoChannels.voiceChannelId, voiceChannelId))
  if (!record) {
    await interaction.reply({ content: '❌ Channel no longer exists.', ephemeral: true })
    return
  }

  const member = await interaction.guild!.members.fetch(interaction.user.id)
  if (!canControlChannel(member, record) && !isSudo(member)) {
    await interaction.reply({ content: '❌ You do not have permission.', ephemeral: true })
    return
  }

  await interaction.deferUpdate()

  const fetched = await interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null)
  const vc = fetched?.isVoiceBased() ? fetched : null

  let newName: string
  let autoNameEnabled = true
  let nameTemplate: NameTemplate | null = null
  let manualName: string | null = null
  let fallbackName = record.fallbackName

  // ── Chill (and any future fixed-name template) — set a stable name and turn
  // off auto-rename until the user picks a presence-driven template again.
  if (choice === 'chill') {
    const chillName = `${member.displayName}'s Chill Session`
    newName = chillName
    autoNameEnabled = false
    nameTemplate = null
    manualName = chillName
    fallbackName = chillName
  } else if ((ALL_TEMPLATES as string[]).includes(choice)) {
    nameTemplate = choice as NameTemplate
    autoNameEnabled = true
    const computed = vc ? computeAutoName(vc, record.ownerUserId, nameTemplate) : null
    // If nobody is playing anything, fall back to the existing fallback_name
    // (or a fresh random name if the row was created before fallback existed).
    newName = computed ?? record.fallbackName ?? randomTechName()
    manualName = null
  } else {
    await interaction.editReply({ content: `❌ Unknown template: \`${choice}\``, components: [] })
    return
  }

  // Apply name only — never touch userLimit. The user is the only authority on
  // the per-channel user limit; if they want one, they set it via Discord's
  // channel settings UI. `newName` stays undecorated in the DB (manual/fallback);
  // the visible name gets a trailing emoji + collision dodge.
  const finalName = vc ? decorateChannelName(vc.guild, newName, vc.id) : newName
  if (vc) {
    await vc.edit({ name: finalName }).catch(() => {})
  }
  const tc = await interaction.guild!.channels.fetch(record.textChannelId).catch(() => null)
  const textName = finalName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice-chat'
  if (tc?.isTextBased()) {
    await (tc as any).setName(textName).catch(() => {})
  }

  const updated = {
    ...record,
    manualName,
    autoNameEnabled,
    nameTemplate,
    fallbackName,
  }
  await db.update(autoChannels)
    .set({ manualName, autoNameEnabled, nameTemplate, fallbackName })
    .where(eq(autoChannels.voiceChannelId, voiceChannelId))
    .catch(() => {})

  await postOrUpdateControlPanel(interaction.client, updated)

  const label = nameTemplate ? `${TEMPLATE_LABELS[nameTemplate].emoji} ${TEMPLATE_LABELS[nameTemplate].label}` : '💬 Chill'
  await interaction.editReply({
    content: `✅ Naming template: **${label}**\nChannel name: **${finalName}**\n_(User limit unchanged — set it yourself in Discord channel settings if you want one.)_`,
    components: [],
  })
}

// `ActivityType` import is intentionally retained for compatibility with
// callers that may import it from this module — keeps the export surface
// stable while the implementation moves to autoNaming.ts.
void ActivityType
