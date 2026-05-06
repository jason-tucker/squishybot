/**
 * /sudo → Settings sub-panel.
 *
 * Routing convention (all are sudo-gated):
 *   sudo:set:home                     button — show landing page
 *   sudo:set:nav:{category}           button — open a category panel
 *   sudo:set:reset:{key}              button — clear DB override (fall back to env)
 *   sudo:set:channel:{key}            channel-select — set a channel-id setting
 *   sudo:set:adduser                  user-select — add a sudo user
 *   sudo:set:removeuser               string-select — remove an additional sudo user
 *   sudo:set:autothread:add           channel-select — add an auto-thread channel
 *   sudo:set:autothread:remove        string-select — remove an auto-thread channel
 *   sudo:set:edit_modal:{key}         button — show modal for free-form value (numbers / etc.)
 *   sudo:set:save:{key}               modal submit — persist the modal value
 */
import {
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js'
import { env } from '../config/env'
import { sep } from '../utils/cv2'
import { requireSudo } from '../services/voice/permissions'
import {
  addAutoThreadChannel,
  addSudoUser,
  clearSetting,
  getSetting,
  listAdditionalSudoUsers,
  listAutoThreadChannels,
  listHubs,
  registerHubChannel,
  removeAutoThreadChannel,
  removeSudoUser,
  setSetting,
  unregisterHubChannel,
} from '../services/settings'

// ---------------------------------------------------------------------------
// Setting key registry — adding a new setting is mostly just adding a row here
// + a section to the home panel.
// ---------------------------------------------------------------------------

interface ChannelSettingDef {
  key: string
  label: string
  description: string
  envFallback?: string
  channelTypes: ChannelType[]
}

const CHANNEL_SETTINGS: ChannelSettingDef[] = [
  { key: 'channel.log', label: 'Log channel', description: 'Bot writes structured log lines here', envFallback: env.LOG_CHANNEL_ID, channelTypes: [ChannelType.GuildText] },
  { key: 'channel.admin', label: 'Admin channel', description: 'Sudo-only bot admin channel', envFallback: env.ADMIN_CHANNEL_ID, channelTypes: [ChannelType.GuildText] },
  { key: 'channel.birthday', label: 'Birthday channel', description: 'Where birthday pings post', envFallback: env.BIRTHDAY_CHANNEL_ID, channelTypes: [ChannelType.GuildText] },
  { key: 'channel.staff_approval_thread', label: 'Staff approval thread', description: 'Where staff requests post for approval', envFallback: env.STAFF_APPROVAL_THREAD_ID, channelTypes: [ChannelType.PublicThread, ChannelType.PrivateThread] },
]

// Voice category — managed under Voice (alongside cleanup delay) rather than
// Channels because it pairs with the hub/auto-channel infrastructure.
const VOICE_CATEGORY_SETTING: ChannelSettingDef = {
  key: 'channel.auto_voice_category',
  label: 'Auto-voice category',
  description: 'Parent category for hubs and auto channels',
  envFallback: env.AUTO_VOICE_CATEGORY_ID,
  channelTypes: [ChannelType.GuildCategory],
}

interface NumericSettingDef {
  key: string
  label: string
  description: string
  envFallback: number
  min?: number
  max?: number
}

const NUMERIC_SETTINGS: NumericSettingDef[] = [
  { key: 'voice.cleanup_delay_ms', label: 'Cleanup delay (ms)', description: 'Empty auto channels are deleted after this many ms', envFallback: env.VOICE_CLEANUP_DELAY_MS, min: 0, max: 600000 },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function channelMentionOrNone(id: string | null | undefined): string {
  if (!id) return '`unset`'
  return `<#${id}>`
}

function effectiveChannelValue(def: ChannelSettingDef): { value: string | null; source: 'override' | 'env' | 'none' } {
  const override = getSetting(def.key)
  if (override) return { value: override, source: 'override' }
  if (def.envFallback) return { value: def.envFallback, source: 'env' }
  return { value: null, source: 'none' }
}

function effectiveNumericValue(def: NumericSettingDef): { value: number; source: 'override' | 'env' } {
  const override = getSetting(def.key)
  if (override !== null) {
    const n = Number(override)
    if (Number.isFinite(n)) return { value: n, source: 'override' }
  }
  return { value: def.envFallback, source: 'env' }
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderHome() {
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## ⚙️ Settings'))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      '_Runtime overrides for what would normally be in `.env`._\n' +
      '_Reset on any value to fall back to the env value._\n\n' +
      'Pick a category to manage:'
    ))

  const row1 = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:nav:sudo_users').setLabel('Sudo Users').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sudo:set:nav:channels').setLabel('Channels').setEmoji('📺').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sudo:set:nav:voice').setLabel('Voice').setEmoji('🔊').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sudo:set:nav:hubs').setLabel('Hub Channels').setEmoji('🪐').setStyle(ButtonStyle.Primary),
  )
  const row2 = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:nav:auto_threads').setLabel('Auto Threads').setEmoji('🧵').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sudo:set:nav:games').setLabel('Games').setEmoji('🎮').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sudo:set:nav:profiles').setLabel('User Profiles').setEmoji('👤').setStyle(ButtonStyle.Secondary),
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components: [container, row1, row2] }
}

async function renderSudoUsers() {
  const additional = listAdditionalSudoUsers()
  const envIds = env.SUDO_USER_IDS

  const lines: string[] = []
  lines.push('### 🛡️ Sudo Users')
  lines.push('_Members with full bot-admin powers. Env values cannot be removed at runtime._\n')
  lines.push(`**From \`SUDO_USER_IDS\` env (${envIds.length}):**`)
  lines.push(envIds.length > 0 ? envIds.map(id => `- <@${id}>`).join('\n') : '- _none_')
  lines.push('')
  lines.push(`**Added at runtime (${additional.length}):**`)
  lines.push(additional.length > 0 ? additional.map(id => `- <@${id}>`).join('\n') : '- _none_')

  const container = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addSeparatorComponents(sep())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('Add a member as sudo:'))

  const components: any[] = [container]
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId('sudo:set:adduser')
        .setPlaceholder('Pick a member to grant sudo…')
        .setMinValues(1).setMaxValues(1)
    )
  )

  if (additional.length > 0) {
    const removeMenu = new StringSelectMenuBuilder()
      .setCustomId('sudo:set:removeuser')
      .setPlaceholder('Remove an additional sudo user…')
      .addOptions(additional.slice(0, 25).map(id => ({ label: id, value: id, emoji: '❌' })))
    components.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(removeMenu))
  }

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary)
    )
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

function renderChannels() {
  const lines: string[] = []
  lines.push('### 📺 Channels')
  lines.push('_Select a channel to override the env value. Reset to fall back to env._\n')
  for (const def of CHANNEL_SETTINGS) {
    const { value, source } = effectiveChannelValue(def)
    const sourceLabel = source === 'override' ? '⚙️ DB override' : source === 'env' ? '📄 env' : '— unset'
    lines.push(`**${def.label}** · ${channelMentionOrNone(value)} · _${sourceLabel}_\n_${def.description}_`)
    lines.push('')
  }

  const container = new ContainerBuilder()
    .setAccentColor(0xfee75c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]

  // Discord allows up to 5 action rows total. Each ChannelSelectMenu owns a row.
  // 6 channel settings → 5 selects + a final back/reset row. Last setting (staff
  // approval thread) is editable via dedicated row that includes its own Reset.
  for (const def of CHANNEL_SETTINGS.slice(0, 5)) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`sudo:set:channel:${def.key}`)
          .setPlaceholder(def.label)
          .setChannelTypes(def.channelTypes)
          .setMinValues(0).setMaxValues(1)
      )
    )
  }

  // Reset/back row — also has buttons to reset each channel override
  const navRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sudo:set:nav:channels_reset').setLabel('Reset Overrides').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
  )
  components.push(navRow)

  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

function renderChannelsReset() {
  const lines: string[] = []
  lines.push('### ♻️ Reset a channel override')
  lines.push('_Pick which override to clear; the bot will fall back to the env value._\n')
  for (const def of CHANNEL_SETTINGS) {
    const { source } = effectiveChannelValue(def)
    const marker = source === 'override' ? '🔵' : '⚪'
    lines.push(`${marker} **${def.label}** _(${source})_`)
  }
  const container = new ContainerBuilder()
    .setAccentColor(0xfee75c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const overrides = CHANNEL_SETTINGS.filter(d => effectiveChannelValue(d).source === 'override')
  const components: any[] = [container]
  if (overrides.length === 0) {
    container.addSeparatorComponents(sep())
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('_No DB overrides set — every channel is using its env value._'))
  } else {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('sudo:set:reset_channel')
      .setPlaceholder('Pick a channel override to clear…')
      .addOptions(overrides.map(d => ({ label: d.label, value: d.key, emoji: '♻️' })))
    components.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu))
  }
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:nav:channels').setLabel('Back to Channels').setStyle(ButtonStyle.Secondary)
    )
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

function renderVoice() {
  const lines: string[] = ['### 🔊 Voice', '_Auto channel runtime tuning._\n']
  for (const def of NUMERIC_SETTINGS) {
    const { value, source } = effectiveNumericValue(def)
    const sourceLabel = source === 'override' ? '⚙️ DB override' : '📄 env'
    lines.push(`**${def.label}** · \`${value}\` · _${sourceLabel}_\n_${def.description}_\n`)
  }
  const cat = effectiveChannelValue(VOICE_CATEGORY_SETTING)
  const catSourceLabel = cat.source === 'override' ? '⚙️ DB override' : cat.source === 'env' ? '📄 env' : '— unset'
  lines.push(`**${VOICE_CATEGORY_SETTING.label}** · ${channelMentionOrNone(cat.value)} · _${catSourceLabel}_\n_${VOICE_CATEGORY_SETTING.description}_`)
  lines.push(`\n**Hub channels** are managed under the dedicated **Hub Channels** sub-panel (separate button on the Settings home).`)

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`sudo:set:channel:${VOICE_CATEGORY_SETTING.key}`)
        .setPlaceholder(VOICE_CATEGORY_SETTING.label)
        .setChannelTypes(VOICE_CATEGORY_SETTING.channelTypes)
        .setMinValues(0).setMaxValues(1)
    )
  )
  for (const def of NUMERIC_SETTINGS) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`sudo:set:edit_modal:${def.key}`).setLabel(`Edit ${def.label}`).setEmoji('✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`sudo:set:reset:${def.key}`).setLabel('Reset').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
      )
    )
  }
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sudo:set:reset:${VOICE_CATEGORY_SETTING.key}`).setLabel('Reset Category').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
    )
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

function renderHubs() {
  const hubs = listHubs()

  const lines: string[] = [
    '### 🪐 Hub Channels',
    '_Voice channels listed here act as auto-channel **hubs**: when a member joins one,_',
    '_the hub renames in place into the member\'s personal room and a replacement hub spawns._\n',
  ]
  if (hubs.length === 0) {
    lines.push('_No hubs registered. Pick a voice channel below to register one._')
  } else {
    for (const h of hubs) {
      lines.push(`• <#${h.channelId}>  _${h.label}_  · category <#${h.categoryId}>`)
    }
  }
  if (env.HUB_CHANNEL_IDS.length > 0) {
    lines.push(`\n_Env \`HUB_CHANNEL_IDS\` (legacy seed): ${env.HUB_CHANNEL_IDS.map(id => `\`${id}\``).join(', ')}_`)
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('sudo:set:hub:add')
        .setPlaceholder('Add a voice channel as a hub…')
        .setChannelTypes([ChannelType.GuildVoice])
        .setMinValues(0).setMaxValues(1)
    )
  )

  if (hubs.length > 0) {
    const removeOptions = hubs.slice(0, 25).map(h => ({
      label: (h.label || h.channelId).slice(0, 100),
      value: h.channelId,
      emoji: '❌',
      description: `<#${h.channelId}> in category ${h.categoryId}`.slice(0, 100),
    }))
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sudo:set:hub:remove')
          .setPlaceholder('Unregister a hub…')
          .addOptions(removeOptions)
      )
    )
  }

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary)
    )
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

function renderAutoThreads() {
  const channels = listAutoThreadChannels()

  const lines: string[] = [
    '### 🧵 Auto Threads',
    '_Channels in this list get an auto-created public thread on every non-bot message._',
    '_Default thread name: `{author} — {first line of message}`._\n',
  ]
  if (channels.length === 0) {
    lines.push('_No channels configured. Pick one below to start auto-threading._')
  } else {
    for (const c of channels) {
      lines.push(`• <#${c.channelId}>`)
    }
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x57f287)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('sudo:set:autothread:add')
        .setPlaceholder('Add a text channel to auto-thread…')
        .setChannelTypes([ChannelType.GuildText])
        .setMinValues(0).setMaxValues(1)
    )
  )

  if (channels.length > 0) {
    const removeOptions = channels.slice(0, 25).map(c => ({
      label: `#${c.channelId}`.slice(0, 100),
      value: c.channelId,
      emoji: '❌',
      description: c.nameTemplate ?? undefined,
    }))
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sudo:set:autothread:remove')
          .setPlaceholder('Remove an auto-thread channel…')
          .addOptions(removeOptions)
      )
    )
  }

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary)
    )
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

async function renderGames(guildId: string) {
  const { renderCatalogList } = await import('./gamesEditor')
  return renderCatalogList(guildId)
}

async function renderProfiles(guildId: string) {
  const { renderSudoUserPicker } = await import('./profileEditor')
  return renderSudoUserPicker(guildId)
}

// ---------------------------------------------------------------------------
// Public entry — called from the existing /sudo select handler
// ---------------------------------------------------------------------------

export async function showSettingsPanel(interaction: StringSelectMenuInteraction | ButtonInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  const payload = renderHome()
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload as any)
  } else {
    await interaction.update(payload as any)
  }
}

// ---------------------------------------------------------------------------
// Button + select + modal handlers
// ---------------------------------------------------------------------------

export async function handleSettingsButton(interaction: ButtonInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  const id = interaction.customId

  // sudo:set:home
  if (id === 'sudo:set:home') {
    await interaction.update(renderHome() as any)
    return
  }

  // sudo:set:nav:{category}
  if (id.startsWith('sudo:set:nav:')) {
    const category = id.slice('sudo:set:nav:'.length)
    if (category === 'sudo_users') {
      await interaction.update((await renderSudoUsers()) as any)
    } else if (category === 'channels') {
      await interaction.update(renderChannels() as any)
    } else if (category === 'channels_reset') {
      await interaction.update(renderChannelsReset() as any)
    } else if (category === 'voice') {
      await interaction.update(renderVoice() as any)
    } else if (category === 'hubs') {
      await interaction.update(renderHubs() as any)
    } else if (category === 'auto_threads') {
      await interaction.update(renderAutoThreads() as any)
    } else if (category === 'games') {
      await interaction.update((await renderGames(interaction.guildId!)) as any)
    } else if (category === 'profiles') {
      await interaction.update((await renderProfiles(interaction.guildId!)) as any)
    } else {
      await interaction.reply({ content: `Unknown category: ${category}`, ephemeral: true })
    }
    return
  }

  // sudo:set:reset:{key}  — clear a numeric or voice-side setting override
  if (id.startsWith('sudo:set:reset:')) {
    const key = id.slice('sudo:set:reset:'.length)
    await clearSetting(key)
    // Heuristic: numeric + voice-category settings live in the Voice panel.
    if (NUMERIC_SETTINGS.some(d => d.key === key) || key === VOICE_CATEGORY_SETTING.key) {
      await interaction.update(renderVoice() as any)
    } else {
      await interaction.update(renderHome() as any)
    }
    return
  }

  // sudo:set:edit_modal:{key}
  if (id.startsWith('sudo:set:edit_modal:')) {
    const key = id.slice('sudo:set:edit_modal:'.length)
    const numDef = NUMERIC_SETTINGS.find(d => d.key === key)
    if (!numDef) {
      await interaction.reply({ content: `Unknown setting: ${key}`, ephemeral: true })
      return
    }
    const { value } = effectiveNumericValue(numDef)
    const modal = new ModalBuilder()
      .setCustomId(`sudo:set:save:${key}`)
      .setTitle(`Edit ${numDef.label}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('value')
            .setLabel(numDef.label)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(value))
            .setPlaceholder(numDef.description)
        )
      )
    await interaction.showModal(modal)
    return
  }
}

export async function handleSettingsChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  const id = interaction.customId

  if (id === 'sudo:set:autothread:add') {
    const channelId = interaction.values[0]
    if (channelId && interaction.guildId) {
      await addAutoThreadChannel(channelId, interaction.guildId, interaction.user.id)
    }
    await interaction.update(renderAutoThreads() as any)
    return
  }

  if (id === 'sudo:set:hub:add') {
    const channelId = interaction.values[0]
    if (channelId && interaction.guild) {
      const vc = await interaction.guild.channels.fetch(channelId).catch(() => null)
      if (vc?.isVoiceBased()) {
        const categoryOverride = getSetting('channel.auto_voice_category')
        await registerHubChannel({
          channelId: vc.id,
          guildId: interaction.guild.id,
          categoryId: vc.parentId ?? categoryOverride ?? env.AUTO_VOICE_CATEGORY_ID,
          position: vc.position,
          label: vc.name,
        })
      }
    }
    await interaction.update(renderHubs() as any)
    return
  }

  const key = id.slice('sudo:set:channel:'.length)
  const def = CHANNEL_SETTINGS.find(d => d.key === key) ?? (key === VOICE_CATEGORY_SETTING.key ? VOICE_CATEGORY_SETTING : null)
  if (!def) {
    await interaction.reply({ content: `Unknown channel setting: ${key}`, ephemeral: true })
    return
  }
  const channelId = interaction.values[0]
  if (channelId) {
    await setSetting(def.key, channelId, interaction.user.id)
  }
  // Re-render the panel the select lives in.
  if (def.key === VOICE_CATEGORY_SETTING.key) {
    await interaction.update(renderVoice() as any)
  } else {
    await interaction.update(renderChannels() as any)
  }
}

export async function handleSettingsUserSelect(interaction: UserSelectMenuInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  const userId = interaction.values[0]
  if (!userId) {
    await interaction.update((await renderSudoUsers()) as any)
    return
  }
  await addSudoUser(userId, interaction.user.id, 'Added via /sudo Settings panel')
  await interaction.update((await renderSudoUsers()) as any)
}

export async function handleSettingsStringSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  const id = interaction.customId
  if (id === 'sudo:set:removeuser') {
    const userId = interaction.values[0]
    if (userId) await removeSudoUser(userId)
    await interaction.update((await renderSudoUsers()) as any)
    return
  }
  if (id === 'sudo:set:reset_channel') {
    const key = interaction.values[0]
    if (key) await clearSetting(key)
    await interaction.update(renderChannelsReset() as any)
    return
  }
  if (id === 'sudo:set:autothread:remove') {
    const channelId = interaction.values[0]
    if (channelId) await removeAutoThreadChannel(channelId)
    await interaction.update(renderAutoThreads() as any)
    return
  }
  if (id === 'sudo:set:hub:remove') {
    const channelId = interaction.values[0]
    if (channelId) await unregisterHubChannel(channelId)
    await interaction.update(renderHubs() as any)
    return
  }
}

export async function handleSettingsModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  const key = interaction.customId.slice('sudo:set:save:'.length)
  const raw = interaction.fields.getTextInputValue('value').trim()
  const numDef = NUMERIC_SETTINGS.find(d => d.key === key)
  if (numDef) {
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      await interaction.reply({ content: `❌ Not a number: \`${raw}\``, ephemeral: true })
      return
    }
    if (numDef.min !== undefined && n < numDef.min) {
      await interaction.reply({ content: `❌ Must be ≥ ${numDef.min}`, ephemeral: true })
      return
    }
    if (numDef.max !== undefined && n > numDef.max) {
      await interaction.reply({ content: `❌ Must be ≤ ${numDef.max}`, ephemeral: true })
      return
    }
    await setSetting(key, String(n), interaction.user.id)
    // Modal was triggered from a panel button → refresh the source message in place.
    // Otherwise fall back to an ephemeral confirmation.
    if (interaction.isFromMessage()) {
      await interaction.update(renderVoice() as any)
    } else {
      await interaction.reply({ content: `✅ Saved \`${key}\` = \`${n}\``, ephemeral: true })
    }
    return
  }
  // Generic string fallback
  await setSetting(key, raw, interaction.user.id)
  await interaction.reply({ content: `✅ Saved \`${key}\` = \`${raw.slice(0, 80)}\``, ephemeral: true })
}
