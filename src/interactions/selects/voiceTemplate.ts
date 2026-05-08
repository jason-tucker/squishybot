import { type StringSelectMenuInteraction, ActivityType } from 'discord.js'
import { db } from '../../db/client'
import { autoChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { canControlChannel, isSudo } from '../../services/voice/permissions'
import { postOrUpdateControlPanel } from '../../services/voice/controlPanel'
import { computeAutoName } from '../../services/voice/autoNaming'
import { decodeVcId } from '../../utils/customId'
import { randomTechName } from '../../utils/randomName'

export async function handleVoiceTemplateSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const decoded = decodeVcId(interaction.customId)
  if (!decoded) return

  const { voiceChannelId } = decoded
  const template = interaction.values[0]

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

  const vc = await interaction.guild!.channels.fetch(record.voiceChannelId).catch(() => null)
  const currentGame = member.presence?.activities.find(a => a.type === ActivityType.Playing)?.name ?? null
  const memberCount = vc?.isVoiceBased() ? vc.members.size : 1

  let newName: string
  let userLimit = record.userLimit
  let autoNameEnabled = false
  let nameTemplate: string | null = null
  let manualName: string | null = null

  switch (template) {
    case 'auto': {
      // Use the count-aware helper if anyone in the VC is playing something,
      // else fall back to the clicker's own game or a random tech name.
      const computed = vc?.isVoiceBased() ? computeAutoName(vc, record.ownerUserId, 'auto', userLimit) : null
      newName = computed ?? currentGame ?? randomTechName()
      autoNameEnabled = true
      nameTemplate = 'auto'
      break
    }

    case 'counter': {
      const limit = userLimit > 0 ? userLimit : 4
      const computed = vc?.isVoiceBased() ? computeAutoName(vc, record.ownerUserId, 'counter', limit) : null
      const base = currentGame ?? randomTechName()
      newName = computed ?? `${base} [${memberCount}/${limit}]`
      if (userLimit === 0) userLimit = limit
      nameTemplate = 'counter'
      manualName = base
      break
    }

    case 'comp5':
      newName = currentGame ? `${currentGame} [${memberCount}/5]` : `Competitive [${memberCount}/5]`
      userLimit = 5
      nameTemplate = 'counter'
      manualName = currentGame ?? 'Competitive'
      break

    case 'tryhard':
      newName = currentGame ? `${currentGame} — Tryhard Mode` : 'Tryhard Mode'
      userLimit = 5
      nameTemplate = null
      manualName = newName
      break

    case 'chill':
      newName = `${member.displayName}'s Chill Session`
      userLimit = 0
      nameTemplate = null
      manualName = newName
      break

    default:
      await interaction.editReply({ content: '❌ Unknown template.', components: [] })
      return
  }

  // Apply to Discord channel
  if (vc?.isVoiceBased()) {
    await vc.edit({ name: newName, userLimit }).catch(() => {})
  }

  // Update text channel name too
  const tc = await interaction.guild!.channels.fetch(record.textChannelId).catch(() => null)
  const textName = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice-chat'
  if (tc?.isTextBased()) {
    await (tc as any).setName(textName).catch(() => {})
  }

  // Persist to DB
  const updated = {
    ...record,
    manualName,
    autoNameEnabled,
    nameTemplate,
    userLimit,
  }
  await db.update(autoChannels)
    .set({ manualName, autoNameEnabled, nameTemplate, userLimit })
    .where(eq(autoChannels.voiceChannelId, voiceChannelId))
    .catch(() => {})

  await postOrUpdateControlPanel(interaction.client, updated)

  await interaction.editReply({
    content: `✅ Template applied: **${newName}**`,
    components: [],
  })
}
