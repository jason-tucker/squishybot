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
 *   sudo:set:bool_toggle:{key}        button — flip a boolean setting on/off
 */
import {
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type Guild,
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
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js'
import { eq, isNotNull, or } from 'drizzle-orm'
import { db } from '../db/client'
import { games } from '../db/schema'
import { env } from '../config/env'
import { sep } from '../utils/cv2'
import { logger } from '../services/logger'
import { requireSudo } from '../services/voice/permissions'
import {
  addAutoThreadChannel,
  addSudoUser,
  clearSetting,
  getBoolSetting,
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
import { STAFF_ROLE_DEFS } from '../services/staffRoles'

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
  { key: 'voice.owner_grace_ms', label: 'Owner grace (ms)', description: 'When the owner leaves a non-empty channel, an acting owner runs it for this long before promotion. The original owner can reclaim by rejoining. 0 disables grace (instant transfer).', envFallback: 300000, min: 0, max: 3600000 },
]

interface BoolSettingDef {
  key: string
  label: string
  description: string
  defaultValue: boolean
}

// Boolean toggles that live in the Voice sub-panel.
const VOICE_BOOL_SETTINGS: BoolSettingDef[] = [
  {
    key: 'voice.no_voice_chat_messages',
    label: 'No Voice Channel Messages',
    description: 'When on, the bot replies to messages sent in an auto-voice channel\'s built-in chat, pointing folks at the attached text channel instead.',
    defaultValue: false,
  },
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

  // Three rows of 3 each, then a 4th secondary row, then nav. Splitting
  // off the 5-button row2 because Discord was silently dropping the 2nd
  // and 3rd buttons (Staff Roles + Socials) when row2 had 5 entries —
  // best guess is a CV2 layout constraint we don't see documented. With
  // ≤3 per row, every button consistently renders.
  const row1 = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:nav:sudo_users').setLabel('Sudo Users').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sudo:set:nav:channels').setLabel('Channels').setEmoji('📺').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sudo:set:nav:voice').setLabel('Voice').setEmoji('🔊').setStyle(ButtonStyle.Primary),
  )
  const row2 = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:nav:hubs').setLabel('Hub Channels').setEmoji('🪐').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sudo:set:nav:auto_threads').setLabel('Auto Threads').setEmoji('🧵').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sudo:set:nav:staff_roles').setLabel('Staff Roles').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
  )
  const row3 = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:nav:socials').setLabel('Socials').setEmoji('📡').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sudo:set:nav:games').setLabel('Games').setEmoji('🎮').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sudo:set:nav:profiles').setLabel('User Profiles').setEmoji('👤').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sudo:set:nav:archive').setLabel('Archive').setEmoji('🗄️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sudo:set:nav:debug').setLabel('Debug').setEmoji('🛠️').setStyle(ButtonStyle.Secondary),
  )
  const row4 = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:nav:auto_roles').setLabel('Auto Roles').setEmoji('🎟️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sudo:set:nav:color_roles').setLabel('Color Roles').setEmoji('🎨').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sudo:set:nav:welcome').setLabel('Welcome/Goodbye').setEmoji('👋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sudo:set:nav:reaction_roles').setLabel('Reaction Roles').setEmoji('🎭').setStyle(ButtonStyle.Secondary),
  )
  const row5 = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:nav:game_defaults').setLabel('Game Defaults').setEmoji('🎮').setStyle(ButtonStyle.Secondary),
  )
  const navRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:home').setLabel('Back to /sudo').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components: [container, row1, row2, row3, row4, row5, navRow] }
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
  for (const def of VOICE_BOOL_SETTINGS) {
    const on = getBoolSetting(def.key, def.defaultValue)
    lines.push(`**${def.label}** · ${on ? '🟢 On' : '⚪ Off'}\n_${def.description}_\n`)
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
  for (const def of VOICE_BOOL_SETTINGS) {
    const on = getBoolSetting(def.key, def.defaultValue)
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`sudo:set:bool_toggle:${def.key}`)
          .setLabel(`${on ? 'Disable' : 'Enable'} ${def.label}`)
          .setEmoji(on ? '🔕' : '🔔')
          .setStyle(on ? ButtonStyle.Secondary : ButtonStyle.Success),
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
      const def: string[] = []
      if (h.defaultTemplateKey) def.push(`template \`${h.defaultTemplateKey}\``)
      if (h.defaultManualName) def.push(`name \`${h.defaultManualName}\``)
      if (h.defaultUserLimit && h.defaultUserLimit > 0) def.push(`limit \`${h.defaultUserLimit}\``)
      const defaultsLine = def.length > 0 ? `  · defaults: ${def.join(', ')}` : ''
      lines.push(`• <#${h.channelId}>  _${h.label}_  · category <#${h.categoryId}>${defaultsLine}`)
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

    const editOptions = hubs.slice(0, 25).map(h => ({
      label: (h.label || h.channelId).slice(0, 100),
      value: h.channelId,
      emoji: '✏️',
      description: 'Edit defaults: template, name, user limit'.slice(0, 100),
    }))
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sudo:set:hub:edit_defaults')
          .setPlaceholder('Edit defaults for a hub…')
          .addOptions(editOptions)
      )
    )
  }

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sudo:set:nav:hub_lockdown').setLabel('Lockdown').setEmoji('🚨').setStyle(ButtonStyle.Danger),
    )
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

async function renderHubLockdown() {
  const { getServerLockUntil } = await import('../services/voice/hubLockdown')
  const hubs = listHubs()
  const now = Date.now()
  const serverUntil = getServerLockUntil()
  const lockedHubs = hubs.filter(h => {
    // Cache doesn't know lockdown_until — read fresh from DB.
    return false  // placeholder; filled below
  })

  // Read fresh lockdown state from DB for these hubs.
  const { db } = await import('../db/client')
  const { hubChannels } = await import('../db/schema')
  const rows = await db.select().from(hubChannels)
  const lockMap = new Map<string, Date | null>(rows.map(r => [r.channelId, r.lockdownUntil]))

  const lines: string[] = [
    '### 🚨 Hub Lockdown',
    '_Temporarily deny `Connect` on hub voice channels so nobody can join._',
    '_Server-wide lockdown is **bot-owner-only**. Per-hub is sudo-accessible._\n',
  ]
  if (serverUntil) {
    lines.push(`🔴 **Server-wide lockdown active** — expires <t:${Math.floor(serverUntil.getTime() / 1000)}:R>`)
  } else {
    lines.push('🟢 Server-wide: not locked')
  }
  lines.push('')
  for (const h of hubs) {
    const until = lockMap.get(h.channelId)
    if (until && until.getTime() > now) {
      lines.push(`🔴 <#${h.channelId}> _${h.label}_ — locked until <t:${Math.floor(until.getTime() / 1000)}:R>`)
    } else {
      lines.push(`🟢 <#${h.channelId}> _${h.label}_`)
    }
  }

  const container = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]

  // Lock-all (bot-owner-only — enforced in handler) — preset durations.
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:hub_lockdown:lock_all:15').setLabel('Lock all 15m').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('sudo:set:hub_lockdown:lock_all:60').setLabel('Lock all 1h').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('sudo:set:hub_lockdown:lock_all:240').setLabel('Lock all 4h').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('sudo:set:hub_lockdown:unlock_all').setLabel('Unlock all').setEmoji('🔓').setStyle(ButtonStyle.Success).setDisabled(!serverUntil),
    )
  )

  if (hubs.length > 0) {
    const lockOptions = hubs.slice(0, 25).map(h => ({
      label: (h.label || h.channelId).slice(0, 100),
      value: h.channelId,
      emoji: '🔒',
      description: `<#${h.channelId}>`.slice(0, 100),
    }))
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sudo:set:hub_lockdown:lock_one_pick')
          .setPlaceholder('Lock an individual hub…')
          .addOptions(lockOptions)
      )
    )

    const currentlyLocked = hubs.filter(h => {
      const u = lockMap.get(h.channelId)
      return u && u.getTime() > now
    })
    if (currentlyLocked.length > 0) {
      const unlockOptions = currentlyLocked.slice(0, 25).map(h => ({
        label: (h.label || h.channelId).slice(0, 100),
        value: h.channelId,
        emoji: '🔓',
        description: `<#${h.channelId}>`.slice(0, 100),
      }))
      components.push(
        new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('sudo:set:hub_lockdown:unlock_one')
            .setPlaceholder('Unlock an individual hub…')
            .addOptions(unlockOptions)
        )
      )
    }
  }

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:nav:hubs').setLabel('Back to Hubs').setStyle(ButtonStyle.Secondary)
    )
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

// Feature flags — bot-owner-only kill switches. Each maps to a setting key
// the relevant entry point reads via getBoolSetting('feature.<key>', true).
interface FeatureFlagDef {
  key: string
  label: string
  description: string
  defaultOn: boolean
}
const FEATURE_FLAGS: FeatureFlagDef[] = [
  { key: 'feature.auto_voice',         label: 'Auto Voice Channels',  description: 'Hub joins create auto-channels. Existing channels keep working when off.', defaultOn: true },
  { key: 'feature.auto_threads',       label: 'Auto Threads',         description: 'messageCreate creates threads on media in auto-thread channels.',          defaultOn: true },
  { key: 'feature.social_poller',      label: 'Social Poller',        description: 'RSS poller posts new feed items every 30 min.',                            defaultOn: true },
  { key: 'feature.presence_renames',   label: 'Presence Renames',     description: 'Rich presence drives auto-channel name updates.',                          defaultOn: true },
  { key: 'feature.birthday_pings',     label: 'Birthday Pings',       description: 'Daily scheduler fires birthday messages.',                                  defaultOn: true },
  { key: 'feature.auto_role_on_join',  label: 'Auto-role on join',    description: 'Apply configured roles to every new member. Default OFF (#36).',          defaultOn: false },
  { key: 'feature.color_roles',        label: 'Color Roles (/color)', description: 'User-selectable color role manager. Default OFF (#38).',                    defaultOn: false },
]

async function renderDebug(client: any, userId: string) {
  const { isBotOwner } = await import('../services/botOwner')
  const owner = await isBotOwner(client, userId)
  const lines: string[] = [
    '### 🛠️ Debug',
    '_Bot-owner-only diagnostic surfaces. Sudo can see this page; only bot owners can fire the buttons._\n',
    owner ? '🟢 You **are** a bot owner.' : '🔒 You are **not** a bot owner — buttons will deny.',
  ]
  const container = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:nav:feature_flags').setLabel('Feature flags').setEmoji('🚦').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sudo:set:nav:orphan_scan').setLabel('Orphan resource scan').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sudo:set:nav:heartbeat').setLabel('Heartbeat').setEmoji('💓').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sudo:set:debug:clear_caches').setLabel('Force-clear caches').setEmoji('🧹').setStyle(ButtonStyle.Danger),
    ),
  )
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:nav:staff_history').setLabel('Staff request history').setEmoji('📜').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sudo:set:nav:audit_log').setLabel('Audit log').setEmoji('📝').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sudo:set:nav:usage_stats').setLabel('Usage stats').setEmoji('📊').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sudo:set:nav:report_triage').setLabel('Report triage').setEmoji('📨').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary),
    ),
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

async function renderHeartbeat(client: any) {
  // DB latency: probe with a trivial round-trip.
  const { db } = await import('../db/client')
  const { sql } = await import('drizzle-orm')
  const start = Date.now()
  let dbMs: number | null = null
  let dbErr: string | null = null
  try {
    await db.execute(sql`SELECT 1`)
    dbMs = Date.now() - start
  } catch (err) {
    dbErr = (err as Error).message
  }

  const wsPing = client.ws?.ping ?? -1
  const uptimeSec = Math.floor((client.uptime ?? 0) / 1000)
  const uptimeStr = uptimeSec > 0
    ? `${Math.floor(uptimeSec / 86400)}d ${Math.floor((uptimeSec % 86400) / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
    : '_unknown_'

  // Best-effort version from package.json + git SHA from env (set by CI build).
  let version = '_unknown_'
  try {
    const pkg = await import('../../package.json' as any)
    version = (pkg as any).version ?? '_unknown_'
  } catch {}
  const sha = process.env.GIT_SHA ?? process.env.SOURCE_COMMIT ?? '_unset_'
  const startTime = client.readyTimestamp ? `<t:${Math.floor(client.readyTimestamp / 1000)}:F> (<t:${Math.floor(client.readyTimestamp / 1000)}:R>)` : '_unknown_'

  const lines = [
    '### 💓 Bot Heartbeat',
    `**Gateway ping:** ${wsPing >= 0 ? `${wsPing}ms` : '_unknown_'}`,
    `**DB latency:** ${dbMs !== null ? `${dbMs}ms` : `❌ ${dbErr}`}`,
    `**Process uptime:** ${uptimeStr}`,
    `**Version:** \`${version}\``,
    `**Git SHA:** \`${sha}\``,
    `**Started:** ${startTime}`,
    `**Bot owners:** ${(await (await import('../services/botOwner')).getBotOwnerIds(client)).size}`,
  ]
  const container = new ContainerBuilder()
    .setAccentColor(0x57f287)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
  const back = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:nav:heartbeat').setLabel('Refresh').setEmoji('♻️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sudo:set:nav:debug').setLabel('Back to Debug').setStyle(ButtonStyle.Secondary),
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components: [container, back] }
}

async function renderAuditLog() {
  const { db } = await import('../db/client')
  const { settingChanges } = await import('../db/schema')
  const { desc } = await import('drizzle-orm')
  const rows = await db.select().from(settingChanges).orderBy(desc(settingChanges.changedAt)).limit(20)

  const lines = ['### 📝 Audit log — recent settings changes', `_Showing the most recent ${rows.length} change(s)._\n`]
  if (rows.length === 0) {
    lines.push('_No setting changes recorded yet._')
  } else {
    for (const r of rows) {
      const when = `<t:${Math.floor(r.changedAt.getTime() / 1000)}:R>`
      const who = r.changedByUserId ? `<@${r.changedByUserId}>` : '_(unknown)_'
      const old = r.oldValue === null ? '_(unset)_' : `\`${r.oldValue.slice(0, 40)}\``
      const next = r.newValue === null ? '_(cleared)_' : `\`${r.newValue.slice(0, 40)}\``
      lines.push(`• ${when} · ${who} · \`${r.key}\` · ${old} → ${next}`)
    }
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 3900)))
  const back = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:nav:audit_log').setLabel('Refresh').setEmoji('♻️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sudo:set:nav:debug').setLabel('Back to Debug').setStyle(ButtonStyle.Secondary),
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components: [container, back] }
}

async function renderUsageStats(guildId: string) {
  const { db } = await import('../db/client')
  const { autoChannels, staffApprovals, settingChanges } = await import('../db/schema')
  const { gte, and: andOp, count, sql } = await import('drizzle-orm')
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const [autoToday, autoWeek, reportsToday, reportsWeek, settingsToday, settingsWeek] = await Promise.all([
    db.select({ n: count() }).from(autoChannels).where(andOp(eq(autoChannels.guildId, guildId), gte(autoChannels.createdAt, dayAgo))),
    db.select({ n: count() }).from(autoChannels).where(andOp(eq(autoChannels.guildId, guildId), gte(autoChannels.createdAt, weekAgo))),
    db.select({ n: count() }).from(staffApprovals).where(andOp(eq(staffApprovals.guildId, guildId), gte(staffApprovals.createdAt, dayAgo))),
    db.select({ n: count() }).from(staffApprovals).where(andOp(eq(staffApprovals.guildId, guildId), gte(staffApprovals.createdAt, weekAgo))),
    db.select({ n: count() }).from(settingChanges).where(gte(settingChanges.changedAt, dayAgo)),
    db.select({ n: count() }).from(settingChanges).where(gte(settingChanges.changedAt, weekAgo)),
  ])

  void sql  // satisfy linter — kept for future row-level stats

  const lines = [
    '### 📊 Usage stats',
    '| Feature | Today | This week |',
    '|---|---|---|',
    `| Auto channels created | ${autoToday[0]?.n ?? 0} | ${autoWeek[0]?.n ?? 0} |`,
    `| Staff requests filed | ${reportsToday[0]?.n ?? 0} | ${reportsWeek[0]?.n ?? 0} |`,
    `| Settings changes | ${settingsToday[0]?.n ?? 0} | ${settingsWeek[0]?.n ?? 0} |`,
  ]
  const container = new ContainerBuilder()
    .setAccentColor(0x57f287)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
  const back = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:nav:usage_stats').setLabel('Refresh').setEmoji('♻️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sudo:set:nav:debug').setLabel('Back to Debug').setStyle(ButtonStyle.Secondary),
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components: [container, back] }
}

async function renderAutoRoles(guildId: string) {
  const { db } = await import('../db/client')
  const { autoJoinRoles } = await import('../db/schema')
  const rows = await db.select().from(autoJoinRoles).where(eq(autoJoinRoles.guildId, guildId))
  const featureOn = getBoolSetting('feature.auto_role_on_join', false)

  const lines = [
    '### 🎟️ Auto-role on join',
    `_Roles applied to every new non-bot member when they join the server._`,
    `_Feature flag (\`feature.auto_role_on_join\`): ${featureOn ? '🟢 **On**' : '⚪ Off'}_\n`,
  ]
  if (rows.length === 0) lines.push('_No roles configured. Pick one below to add._')
  else for (const r of rows) lines.push(`• <@&${r.roleId}>`)

  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]
  const { RoleSelectMenuBuilder } = await import('discord.js')
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId('sudo:set:auto_role:add')
        .setPlaceholder('Add an auto-join role…')
        .setMinValues(0).setMaxValues(1),
    ),
  )
  if (rows.length > 0) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sudo:set:auto_role:remove')
          .setPlaceholder('Remove an auto-join role…')
          .addOptions(rows.slice(0, 25).map(r => ({ label: r.roleId, value: r.roleId, emoji: '❌' }))),
      ),
    )
  }
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary),
    ),
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

async function renderColorRoles(guildId: string) {
  const { db } = await import('../db/client')
  const { colorRoles } = await import('../db/schema')
  const rows = await db.select().from(colorRoles).where(eq(colorRoles.guildId, guildId))
  const featureOn = getBoolSetting('feature.color_roles', false)

  const lines = [
    '### 🎨 Color roles',
    `_Member-selectable color roles. Members run \`/color\` to pick one; bot swaps any existing pick._`,
    `_Feature flag (\`feature.color_roles\`): ${featureOn ? '🟢 **On**' : '⚪ Off'} — toggle in Debug → Feature flags._\n`,
  ]
  if (rows.length === 0) lines.push('_No color roles configured. Add one below._')
  else for (const r of rows) lines.push(`• <@&${r.roleId}> _${r.label}_`)

  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]
  const { RoleSelectMenuBuilder } = await import('discord.js')
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId('sudo:set:color_role:add')
        .setPlaceholder('Add a color role…')
        .setMinValues(0).setMaxValues(1),
    ),
  )
  if (rows.length > 0) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sudo:set:color_role:remove')
          .setPlaceholder('Remove a color role…')
          .addOptions(rows.slice(0, 25).map(r => ({ label: r.label.slice(0, 100), value: r.roleId, emoji: '❌' }))),
      ),
    )
  }
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary),
    ),
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

async function renderReportTriage(guildId: string) {
  const { db } = await import('../db/client')
  const { reportLog } = await import('../db/schema')
  const { desc } = await import('drizzle-orm')
  const rows = await db.select().from(reportLog).where(eq(reportLog.guildId, guildId)).orderBy(desc(reportLog.createdAt)).limit(20)

  const lines = ['### 📨 /report triage (bot-owner only)', `_Showing the most recent ${rows.length} report(s)._\n`]
  if (rows.length === 0) {
    lines.push('_No reports filed yet._')
  } else {
    for (const r of rows) {
      const when = `<t:${Math.floor(r.createdAt.getTime() / 1000)}:R>`
      const icon = r.status === 'filed' ? '✅' : r.status === 'dropped' ? '❌' : '⏳'
      const link = r.githubIssueUrl ? ` · [issue](${r.githubIssueUrl})` : ''
      lines.push(`${icon} <@${r.userId}> · **${r.title.slice(0, 80)}** · \`${r.reportType}\` · ${when}${link}`)
    }
  }
  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 3900)))
  const back = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:nav:report_triage').setLabel('Refresh').setEmoji('♻️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sudo:set:nav:debug').setLabel('Back to Debug').setStyle(ButtonStyle.Secondary),
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components: [container, back] }
}

async function renderReactionRoles() {
  const { listReactionRoles } = await import('../services/reactionRoles')
  const rows = listReactionRoles()
  const lines = [
    '### 🎭 Reaction Roles',
    '_Each entry is a Discord message the bot watches. Click emoji on the message → bot toggles the mapped role on you._\n',
  ]
  if (rows.length === 0) lines.push('_No reaction-role messages yet. Use **Create** to make one._')
  else {
    for (const r of rows) {
      const exp = r.expiresAt ? ` · expires <t:${Math.floor(r.expiresAt.getTime() / 1000)}:R>` : ''
      lines.push(`• <#${r.channelId}> · \`${r.messageId.slice(-6)}\` · ${r.mappings.length} mapping${r.mappings.length === 1 ? '' : 's'}${exp}`)
    }
  }
  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:reaction_roles:create').setLabel('Create reaction-role message').setEmoji('➕').setStyle(ButtonStyle.Primary),
    ),
  )
  if (rows.length > 0) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sudo:set:reaction_roles:delete')
          .setPlaceholder('Delete a reaction-role message…')
          .addOptions(rows.slice(0, 25).map(r => ({
            label: `${r.messageId.slice(-12)} · ${r.mappings.length} mapping(s)`.slice(0, 100),
            value: r.messageId,
            emoji: '🗑️',
            description: `in <#${r.channelId}>`.slice(0, 100),
          }))),
      ),
    )
  }
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary),
    ),
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

async function renderWelcome() {
  const welcomeOn = getBoolSetting('welcome.enabled', false)
  const goodbyeOn = getBoolSetting('goodbye.enabled', false)
  const welcomeCh = getSetting('welcome.channel_id')
  const goodbyeCh = getSetting('goodbye.channel_id')
  const welcomeTpl = getSetting('welcome.template')
  const goodbyeTpl = getSetting('goodbye.template')

  const lines = [
    '### 👋 Welcome / Goodbye',
    '_Posts a message when members join or leave. Supported tokens: `{user}`, `{server}`, `{member_count}`, `{account_age}`. Both are default OFF._\n',
    `**Welcome:** ${welcomeOn ? '🟢 On' : '⚪ Off'} · channel ${welcomeCh ? `<#${welcomeCh}>` : '_unset_'}`,
    `> ${welcomeTpl ? `\`${welcomeTpl.slice(0, 100)}\`` : '_(default)_'}`,
    '',
    `**Goodbye:** ${goodbyeOn ? '🟢 On' : '⚪ Off'} · channel ${goodbyeCh ? `<#${goodbyeCh}>` : '_unset_'}`,
    `> ${goodbyeTpl ? `\`${goodbyeTpl.slice(0, 100)}\`` : '_(default)_'}`,
  ]
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId('sudo:set:channel:welcome.channel_id').setPlaceholder('Welcome channel…').setChannelTypes([ChannelType.GuildText]).setMinValues(0).setMaxValues(1),
    ),
  )
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId('sudo:set:channel:goodbye.channel_id').setPlaceholder('Goodbye channel…').setChannelTypes([ChannelType.GuildText]).setMinValues(0).setMaxValues(1),
    ),
  )
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:welcome:edit_welcome').setLabel('Edit welcome template').setEmoji('✏️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sudo:set:welcome:edit_goodbye').setLabel('Edit goodbye template').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    ),
  )
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:bool_toggle:welcome.enabled').setLabel(welcomeOn ? 'Disable welcome' : 'Enable welcome').setEmoji(welcomeOn ? '🔕' : '🔔').setStyle(welcomeOn ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sudo:set:bool_toggle:goodbye.enabled').setLabel(goodbyeOn ? 'Disable goodbye' : 'Enable goodbye').setEmoji(goodbyeOn ? '🔕' : '🔔').setStyle(goodbyeOn ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary),
    ),
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

async function renderStaffHistory(guildId: string) {
  const { db } = await import('../db/client')
  const { staffApprovals } = await import('../db/schema')
  const { desc } = await import('drizzle-orm')
  const rows = await db.select().from(staffApprovals)
    .where(eq(staffApprovals.guildId, guildId))
    .orderBy(desc(staffApprovals.createdAt))
    .limit(20)

  const lines = ['### 📜 Staff request history', `_Showing the most recent ${rows.length} request(s)._\n`]
  if (rows.length === 0) {
    lines.push('_No requests on file._')
  } else {
    for (const r of rows) {
      const created = `<t:${Math.floor(r.createdAt.getTime() / 1000)}:R>`
      const icon = r.status === 'approved' ? '✅' : r.status === 'denied' ? '❌' : '⏳'
      const d = (r.requestedData as Record<string, unknown>) ?? {}
      const role = String(d.role_label ?? d.role_key ?? d.tier ?? 'unknown')
      lines.push(`${icon} <@${r.userId}> · **${role}** · ${r.status} · ${created}`)
    }
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
  const back = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:nav:debug').setLabel('Back to Debug').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Settings home').setStyle(ButtonStyle.Secondary),
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components: [container, back] }
}

async function renderFeatureFlags() {
  const lines: string[] = [
    '### 🚦 Feature Flags',
    '_Bot-owner-only kill switches per feature. Each toggle gates the relevant entry point at runtime._\n',
  ]
  for (const f of FEATURE_FLAGS) {
    const on = getBoolSetting(f.key, f.defaultOn)
    lines.push(`**${f.label}** · ${on ? '🟢 On' : '⚪ Off'}\n_${f.description}_\n`)
  }

  const container = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]
  for (const f of FEATURE_FLAGS) {
    const on = getBoolSetting(f.key, f.defaultOn)
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`sudo:set:feature:${f.key}`)
          .setLabel(`${on ? 'Disable' : 'Enable'} ${f.label}`)
          .setEmoji(on ? '🔕' : '🔔')
          .setStyle(on ? ButtonStyle.Secondary : ButtonStyle.Success),
      ),
    )
  }
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:nav:debug').setLabel('Back to Debug').setStyle(ButtonStyle.Secondary),
    ),
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

async function renderOrphanScan(client: any, guildId: string) {
  const guild = client.guilds.cache.get(guildId)
  if (!guild) {
    return {
      flags: MessageFlags.IsComponentsV2 as number,
      components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('### 🔎 Orphan scan\n_Guild not in cache._'))],
    }
  }

  const { db } = await import('../db/client')
  const { autoChannels, hubChannels, autoThreadChannels, games, archivedChannels } = await import('../db/schema')

  const [autoRows, hubRows, threadRows, gameRows, archivedRows] = await Promise.all([
    db.select().from(autoChannels),
    db.select().from(hubChannels),
    db.select().from(autoThreadChannels),
    db.select().from(games),
    db.select().from(archivedChannels),
  ])

  const orphans: { table: string; rowKey: string; missingId: string; field: string }[] = []
  const seenInDiscord = (id: string | null | undefined) => !!(id && guild.channels.cache.has(id))
  const roleSeen = (id: string | null | undefined) => !!(id && guild.roles.cache.has(id))

  for (const r of autoRows) {
    if (!seenInDiscord(r.voiceChannelId)) orphans.push({ table: 'auto_channels', rowKey: r.id, missingId: r.voiceChannelId, field: 'voice_channel_id' })
    if (!seenInDiscord(r.textChannelId))  orphans.push({ table: 'auto_channels', rowKey: r.id, missingId: r.textChannelId, field: 'text_channel_id' })
  }
  for (const r of hubRows) {
    if (!seenInDiscord(r.channelId))   orphans.push({ table: 'hub_channels', rowKey: r.id, missingId: r.channelId, field: 'channel_id' })
    if (!seenInDiscord(r.categoryId))  orphans.push({ table: 'hub_channels', rowKey: r.id, missingId: r.categoryId, field: 'category_id' })
  }
  for (const r of threadRows) {
    if (!seenInDiscord(r.channelId))   orphans.push({ table: 'auto_thread_channels', rowKey: r.channelId, missingId: r.channelId, field: 'channel_id' })
  }
  for (const r of gameRows) {
    if (r.channelId && !seenInDiscord(r.channelId))  orphans.push({ table: 'games', rowKey: r.id, missingId: r.channelId, field: 'channel_id' })
    if (r.categoryId && !seenInDiscord(r.categoryId)) orphans.push({ table: 'games', rowKey: r.id, missingId: r.categoryId, field: 'category_id' })
    if (r.roleId && !roleSeen(r.roleId))             orphans.push({ table: 'games', rowKey: r.id, missingId: r.roleId, field: 'role_id' })
    if (r.pingRoleId && !roleSeen(r.pingRoleId))     orphans.push({ table: 'games', rowKey: r.id, missingId: r.pingRoleId, field: 'ping_role_id' })
  }
  for (const r of archivedRows) {
    if (!seenInDiscord(r.channelId)) orphans.push({ table: 'archived_channels', rowKey: r.channelId, missingId: r.channelId, field: 'channel_id' })
  }

  const lines: string[] = [
    '### 🔎 Orphan resource scan',
    '_Walks bot-managed tables and flags rows referencing Discord channels/roles that no longer exist._\n',
    orphans.length === 0 ? '🟢 **No orphans found.** Everything tracked is still alive in Discord.' : `🟡 **${orphans.length} orphan reference${orphans.length === 1 ? '' : 's'} found:**`,
  ]
  for (const o of orphans.slice(0, 30)) {
    lines.push(`• \`${o.table}.${o.field}\` → \`${o.missingId}\` (row \`${o.rowKey.slice(0, 12)}\`)`)
  }
  if (orphans.length > 30) lines.push(`_…and ${orphans.length - 30} more._`)

  const container = new ContainerBuilder()
    .setAccentColor(orphans.length === 0 ? 0x57f287 : 0xfee75c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:debug:cleanup_orphans').setLabel('Clean up orphan rows').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(orphans.length === 0),
      new ButtonBuilder().setCustomId('sudo:set:nav:orphan_scan').setLabel('Re-scan').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sudo:set:nav:debug').setLabel('Back to Debug').setStyle(ButtonStyle.Secondary),
    ),
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

async function renderArchive(client: any, guildId: string) {
  const {
    listEligibleCategories,
    listArchived,
    getStaleDays,
    getArchiveDestinationCategoryId,
  } = await import('../services/archive')

  const [eligible, archived] = await Promise.all([
    listEligibleCategories(guildId),
    listArchived(guildId),
  ])
  const destinationId = getArchiveDestinationCategoryId()
  const staleDays = getStaleDays()

  const lines: string[] = [
    '### 🗄️ Channel Archive',
    '_Manual, sudo-driven. Only channels inside **opt-in** categories are scannable. Archive moves the channel to a destination category, denies @everyone Send, and prepends 🗄️ to the name. Reversible._\n',
    `**Destination category:** ${destinationId ? `<#${destinationId}>` : '`unset` _(required before archiving)_'}`,
    `**Stale threshold:** \`${staleDays}\` days`,
    `**Eligible categories (${eligible.length}):**`,
    eligible.length === 0 ? '_None yet. Pick one below to opt in._' : eligible.map(id => `• <#${id}>`).join('\n'),
    '',
    `**Currently archived (${archived.length}):**`,
    archived.length === 0 ? '_None._' : archived.slice(0, 10).map(a => `• <#${a.channelId}> _${a.originalName}_ · <t:${Math.floor(a.archivedAt.getTime() / 1000)}:R>`).join('\n'),
  ]

  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]

  // Destination category picker
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('sudo:set:channel:channel.archive_destination')
        .setPlaceholder('Set archive destination category…')
        .setChannelTypes([ChannelType.GuildCategory])
        .setMinValues(0).setMaxValues(1),
    ),
  )

  // Eligible-category add (channel select on categories)
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('sudo:set:archive:add_eligible')
        .setPlaceholder('Add an opt-in category…')
        .setChannelTypes([ChannelType.GuildCategory])
        .setMinValues(0).setMaxValues(1),
    ),
  )

  // Eligible-category remove
  if (eligible.length > 0) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sudo:set:archive:remove_eligible')
          .setPlaceholder('Remove an opt-in category…')
          .addOptions(eligible.slice(0, 25).map(id => ({ label: id, value: id, emoji: '❌' }))),
      ),
    )
  }

  // Action buttons
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:archive:edit_threshold').setLabel(`Stale: ${staleDays}d`).setEmoji('✏️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sudo:set:archive:scan').setLabel('Scan stale channels').setEmoji('🔎').setStyle(ButtonStyle.Primary).setDisabled(eligible.length === 0 || !destinationId),
    ),
  )

  // Unarchive
  if (archived.length > 0) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sudo:set:archive:unarchive')
          .setPlaceholder('Unarchive a channel…')
          .addOptions(archived.slice(0, 25).map(a => ({ label: a.originalName.slice(0, 100), value: a.channelId, emoji: '🔓', description: `<#${a.channelId}>`.slice(0, 100) }))),
      ),
    )
  }

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary),
    ),
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

async function renderArchiveScanResults(client: any, guildId: string) {
  const { scanStaleChannels } = await import('../services/archive')
  const stale = await scanStaleChannels(client, guildId)

  const lines: string[] = [
    '### 🔎 Stale channel scan',
    stale.length === 0
      ? '_No stale channels found in opt-in categories._'
      : `_Found **${stale.length}** stale channel${stale.length === 1 ? '' : 's'}. Pick which to archive._`,
  ]
  for (const s of stale.slice(0, 25)) {
    const ts = s.lastMessageAt ? `<t:${Math.floor(s.lastMessageAt.getTime() / 1000)}:R>` : '_no messages ever_'
    lines.push(`• <#${s.channelId}> — last message ${ts} · category <#${s.categoryId}>`)
  }

  const container = new ContainerBuilder()
    .setAccentColor(0xfee75c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]

  if (stale.length > 0) {
    const options = stale.slice(0, 25).map(s => ({
      label: s.name.slice(0, 100),
      value: s.channelId,
      emoji: '🗄️',
      description: (s.lastMessageAt ? `last ${s.lastMessageAt.toISOString().slice(0, 10)}` : 'no messages ever').slice(0, 100),
    }))
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sudo:set:archive:scan_pick')
          .setPlaceholder('Pick channels to archive…')
          .setMinValues(1)
          .setMaxValues(Math.min(stale.length, 25))
          .addOptions(options),
      ),
    )
  }

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:nav:archive').setLabel('Back to Archive').setStyle(ButtonStyle.Secondary),
    ),
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

const ARCHIVE_DURATION_LABEL: Record<number, string> = {
  60: '1 hour',
  1440: '24 hours',
  4320: '3 days',
  10080: '1 week',
}

function renderAutoThreads() {
  const channels = listAutoThreadChannels()

  const lines: string[] = [
    '### 🧵 Auto Threads',
    '_Channels in this list get an auto-created public thread on every non-bot message._',
    '_Default thread name: `{author} — {first line of message}`. Default archive: 24h._\n',
  ]
  if (channels.length === 0) {
    lines.push('_No channels configured. Pick one below to start auto-threading._')
  } else {
    for (const c of channels) {
      const tpl = c.nameTemplate ? `\`${c.nameTemplate}\`` : '_default_'
      const archive = c.archiveDuration ? ARCHIVE_DURATION_LABEL[c.archiveDuration] ?? `${c.archiveDuration}m` : '_default (24h)_'
      lines.push(`• <#${c.channelId}> · template ${tpl} · archive ${archive}`)
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

    // #26 — Edit name template
    const editOptions = channels.slice(0, 25).map(c => ({
      label: `<#${c.channelId}> — edit template`.slice(0, 100),
      value: c.channelId,
      emoji: '✏️',
      description: (c.nameTemplate ?? 'default: {author} — {content}').slice(0, 100),
    }))
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sudo:set:autothread:edit_template')
          .setPlaceholder('Edit thread name template…')
          .addOptions(editOptions)
      )
    )

    // #27 — Set archive duration (per channel)
    const archiveOptions = channels.slice(0, 25).map(c => ({
      label: `<#${c.channelId}> — archive duration`.slice(0, 100),
      value: c.channelId,
      emoji: '⏳',
      description: (c.archiveDuration ? ARCHIVE_DURATION_LABEL[c.archiveDuration] ?? `${c.archiveDuration}m` : 'default (24h)').slice(0, 100),
    }))
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sudo:set:autothread:pick_for_archive')
          .setPlaceholder('Set thread archive duration…')
          .addOptions(archiveOptions)
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

/**
 * Render the Staff Roles sub-panel. For each of the 7 slots, show:
 *   ✅ linked + present in Discord
 *   ⚠️ linked but the role no longer exists in Discord (stale)
 *   🔗 unlinked, but a Discord role with the matching name exists
 *   ❌ unlinked + no matching role in Discord
 */
function renderStaffRoles(guild: Guild) {
  const lines: string[] = ['### 🛡️ Staff Roles']
  lines.push('_Granted on `/staff request` approval. **Provision** auto-creates anything missing,_')
  lines.push('_links by name, and bumps the 7 roles above the highest game role._\n')

  for (const def of STAFF_ROLE_DEFS) {
    const id = getSetting(def.key)
    if (id) {
      const role = guild.roles.cache.get(id)
      if (role) lines.push(`✅ **${def.label}** — <@&${role.id}>`)
      else      lines.push(`⚠️ **${def.label}** — id \`${id}\` no longer exists in Discord`)
    } else {
      const byName = guild.roles.cache.find(r => r.name === def.name && !r.managed)
      if (byName) lines.push(`🔗 **${def.label}** — exists as <@&${byName.id}> but **not linked**`)
      else        lines.push(`❌ **${def.label}** — missing in Discord`)
    }
  }

  const container = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]
  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:staff_roles:provision').setLabel('Provision & link').setEmoji('🛠').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('sudo:set:staff_roles:clear').setLabel('Clear links').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary),
    )
  )
  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

interface ProvisionResult {
  created: string[]
  linked: string[]
  alreadyOk: string[]
  errors: string[]
}

async function provisionStaffRoles(guild: Guild, byUserId: string): Promise<ProvisionResult> {
  const result: ProvisionResult = { created: [], linked: [], alreadyOk: [], errors: [] }

  // 1. Resolve the highest existing game role position so we know where to bump to.
  const gameRoleRows = await db.select({ roleId: games.roleId, pingRoleId: games.pingRoleId })
    .from(games)
    .where(or(isNotNull(games.roleId), isNotNull(games.pingRoleId)))
  const gameRoleIds = new Set<string>()
  for (const r of gameRoleRows) {
    if (r.roleId) gameRoleIds.add(r.roleId)
    if (r.pingRoleId) gameRoleIds.add(r.pingRoleId)
  }
  let basePosition = 0
  for (const id of gameRoleIds) {
    const role = guild.roles.cache.get(id)
    if (role && role.position > basePosition) basePosition = role.position
  }

  // 2. For each slot: prefer the already-linked role, then a name match, else
  // create. In all three cases, also normalize the role's color to the
  // canonical value so reruns repaint manually-fiddled colors back to spec.
  const resolvedIds: Record<string, string> = {}
  for (const def of STAFF_ROLE_DEFS) {
    let role = null
    const linkedId = getSetting(def.key)
    if (linkedId) role = guild.roles.cache.get(linkedId) ?? null
    if (role) {
      resolvedIds[def.key] = role.id
      result.alreadyOk.push(def.label)
    } else {
      const byName = guild.roles.cache.find(r => r.name === def.name && !r.managed) ?? null
      if (byName) {
        await setSetting(def.key, byName.id, byUserId)
        resolvedIds[def.key] = byName.id
        result.linked.push(def.label)
        role = byName
      } else {
        try {
          const created = await guild.roles.create({
            name: def.name,
            color: def.color,
            hoist: true,
            mentionable: false,
            permissions: [],
            reason: `staff role provisioning by ${byUserId}`,
          })
          await setSetting(def.key, created.id, byUserId)
          resolvedIds[def.key] = created.id
          result.created.push(def.label)
          role = created
        } catch (err) {
          logger.warn(`Failed to create staff role ${def.name}:`, err)
          result.errors.push(`${def.label}: ${(err as Error).message}`)
        }
      }
    }
    if (role && role.color !== def.color) {
      try {
        await role.edit({ color: def.color, reason: `staff role color sync by ${byUserId}` })
      } catch (err) {
        logger.warn(`Failed to recolor staff role ${def.name}:`, err)
        result.errors.push(`${def.label} color: ${(err as Error).message}`)
      }
    }
  }

  // 3. Bulk-set positions: each slot one above the previous, starting at base+1.
  const positions = STAFF_ROLE_DEFS
    .map((def, idx) => {
      const id = resolvedIds[def.key]
      return id ? { role: id, position: basePosition + 1 + idx } : null
    })
    .filter((p): p is { role: string; position: number } => p !== null)
  if (positions.length > 0) {
    try {
      await guild.roles.setPositions(positions)
    } catch (err) {
      logger.warn('Failed to setPositions for staff roles:', err)
      result.errors.push(`reposition: ${(err as Error).message}`)
    }
  }

  return result
}

async function renderGames(guildId: string) {
  const { renderCatalogList } = await import('./gamesEditor')
  return renderCatalogList(guildId)
}

// ---------------------------------------------------------------------------
// Socials — RSS-driven feed → channel auto-poster
// ---------------------------------------------------------------------------

const SOCIAL_DEFAULT_CHANNEL_ID = '1121170598417154110'

async function renderSocials() {
  const { listSocialFeeds } = await import('../services/socialFeeds')
  const feeds = listSocialFeeds()

  const lines: string[] = ['### 📡 Socials']
  lines.push('_Polls each enabled RSS feed every 30 min and reposts new items into the configured channel._')
  lines.push('_Use a free aggregator like rss.app to generate RSS URLs for Instagram / X / YouTube / etc. profiles._\n')
  if (feeds.length === 0) {
    lines.push(`_No feeds yet. Click **Add Feed** to wire one up. Default post channel is <#${SOCIAL_DEFAULT_CHANNEL_ID}>._`)
  } else {
    for (const f of feeds) {
      const enabled = f.enabled ? '✅' : '⏸️'
      const errMark = f.lastError ? ' · ⚠️' : ''
      const polled = f.lastPolledAt ? ` · last polled <t:${Math.floor(f.lastPolledAt.getTime() / 1000)}:R>` : ''
      lines.push(`${enabled} **${f.label}** → <#${f.channelId}>${polled}${errMark}`)
    }
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const components: any[] = [container]

  components.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:social:add').setLabel('Add Feed').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sudo:set:home').setLabel('Back').setStyle(ButtonStyle.Secondary),
    )
  )

  if (feeds.length > 0) {
    const opts = feeds.slice(0, 25).map(f => ({
      label: f.label.slice(0, 100),
      value: f.id,
      description: f.sourceUrl.slice(0, 100),
    }))
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sudo:set:social:pick')
          .setPlaceholder('Pick a feed to manage…')
          .addOptions(opts)
      )
    )
  }

  return { flags: MessageFlags.IsComponentsV2 as number, components }
}

async function renderSocialDetail(feedId: string) {
  const { getSocialFeed } = await import('../services/socialFeeds')
  const feed = getSocialFeed(feedId)
  if (!feed) return renderSocials()

  const lines: string[] = [`### 📡 ${feed.label}`]
  lines.push(`**RSS URL:** \`${feed.sourceUrl}\``)
  lines.push(`**Channel:** <#${feed.channelId}>`)
  lines.push(`**Status:** ${feed.enabled ? '✅ Enabled' : '⏸️ Disabled'}`)
  if (feed.lastPolledAt) lines.push(`**Last polled:** <t:${Math.floor(feed.lastPolledAt.getTime() / 1000)}:R>`)
  if (feed.lastSeenId)   lines.push(`**Last item GUID seen:** \`${feed.lastSeenId.slice(0, 60)}${feed.lastSeenId.length > 60 ? '…' : ''}\``)
  if (feed.lastError)    lines.push(`**Last error:** \`${feed.lastError.slice(0, 200)}\``)
  lines.push(`**Max items per poll:** ${feed.maxItemsPerPoll === 0 ? '_0 (latest only, default)_' : `\`${feed.maxItemsPerPoll}\``}`)

  const container = new ContainerBuilder()
    .setAccentColor(feed.lastError ? 0xed4245 : 0x57f287)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))

  const actionRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`sudo:set:social:toggle:${feed.id}`)
      .setLabel(feed.enabled ? 'Enabled' : 'Disabled')
      .setEmoji(feed.enabled ? '✅' : '⏸️')
      .setStyle(feed.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`sudo:set:social:test:${feed.id}`)
      .setLabel('Test (post latest now)')
      .setEmoji('🧪')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sudo:set:social:preview:${feed.id}`)
      .setLabel('Preview style')
      .setEmoji('🎨')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`sudo:set:social:throttle:${feed.id}`)
      .setLabel('Max items')
      .setEmoji('⚙️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`sudo:set:social:remove:${feed.id}`)
      .setLabel('Remove')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
  )
  const navRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:set:nav:socials').setLabel('Back to Socials').setStyle(ButtonStyle.Secondary),
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components: [container, actionRow, navRow] }
}

function buildSocialAddModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('sudo:set:social:add_submit')
    .setTitle('Add Social Feed')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('label').setLabel('Label')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)
          .setPlaceholder('e.g. ITSupportRI Instagram')
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('url').setLabel('RSS URL')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)
          .setPlaceholder('https://rss.app/feeds/...')
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('channel_id').setLabel('Channel ID (override default)')
          .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(30)
          .setValue(SOCIAL_DEFAULT_CHANNEL_ID)
      ),
    )
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
  const id = interaction.customId

  // ── Modal-showing branches FIRST and FAST. `showModal()` IS the
  // interaction response — can't be combined with deferUpdate. We do the
  // sudo check BEFORE showModal here because there's no defer to back us
  // up; the gamble is that requireSudo's member.fetch is fast enough on a
  // cached member, which it is for any sudo who's clicked any other button
  // recently. Worst-case (cold cache), the modal fails to open and the
  // user clicks again.
  if (id === 'sudo:set:social:add') {
    if (!await requireSudo(interaction)) return
    await interaction.showModal(buildSocialAddModal())
    return
  }
  // #29 — Modal for setting the per-feed max items per poll
  if (id.startsWith('sudo:set:social:throttle:')) {
    if (!await requireSudo(interaction)) return
    const feedId = id.slice('sudo:set:social:throttle:'.length)
    const { getSocialFeed } = await import('../services/socialFeeds')
    const feed = getSocialFeed(feedId)
    if (!feed) {
      await interaction.reply({ content: '❌ Feed not found.', ephemeral: true })
      return
    }
    const modal = new ModalBuilder()
      .setCustomId(`sudo:set:social:throttle_submit:${feedId}`)
      .setTitle('Feed: max items per poll')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('n')
            .setLabel('Max items per poll (0 = latest only)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(3)
            .setPlaceholder('0 = latest only · sudo cap is 3 · bot owner unlimited')
            .setValue(String(feed.maxItemsPerPoll)),
        ),
      )
    await interaction.showModal(modal)
    return
  }

  // #37 — Reaction-role create modal
  if (id === 'sudo:set:reaction_roles:create') {
    if (!await requireSudo(interaction)) return
    const modal = new ModalBuilder()
      .setCustomId('sudo:set:reaction_roles:create_submit')
      .setTitle('Create reaction-role message')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('channel_id').setLabel('Channel ID').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(15).setMaxLength(25),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('body').setLabel('Message body').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(1).setMaxLength(1900).setPlaceholder('Pick your team!\n\n🟢 = green-team\n🔴 = red-team'),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('mappings').setLabel('Mappings: emoji=roleId per line').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500).setPlaceholder('🟢=123456789012345678\n🔴=234567890123456789'),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('expires_minutes').setLabel('Expires in N minutes (blank = permanent)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(5),
        ),
      )
    await interaction.showModal(modal)
    return
  }

  // #20 — Edit welcome/goodbye template (modal)
  if (id === 'sudo:set:welcome:edit_welcome' || id === 'sudo:set:welcome:edit_goodbye') {
    if (!await requireSudo(interaction)) return
    const which = id === 'sudo:set:welcome:edit_welcome' ? 'welcome' : 'goodbye'
    const current = getSetting(`${which}.template`) ?? ''
    const modal = new ModalBuilder()
      .setCustomId(`sudo:set:welcome:${which}_submit`)
      .setTitle(`Edit ${which} template`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('template')
            .setLabel('Template (blank = reset to default)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(2000)
            .setValue(current)
            .setPlaceholder('Tokens: {user} {server} {member_count} {account_age}'),
        ),
      )
    await interaction.showModal(modal)
    return
  }
  if (id === 'sudo:set:profiles:csv_import') {
    if (!await requireSudo(interaction)) return
    const modal = new ModalBuilder()
      .setCustomId('sudo:set:profiles:csv_submit')
      .setTitle('Bulk-import birthdays')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('csv')
            .setLabel('CSV: user_id,month,day  OR  user_id,MM-DD')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(4000)
            .setPlaceholder('117501528641634310,11,20\n484484232199012352,03-15\n…'),
        ),
      )
    await interaction.showModal(modal)
    return
  }
  if (id === 'sudo:set:archive:edit_threshold') {
    if (!await requireSudo(interaction)) return
    const { getStaleDays } = await import('../services/archive')
    const modal = new ModalBuilder()
      .setCustomId('sudo:set:archive:edit_threshold_submit')
      .setTitle('Stale threshold')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('days')
            .setLabel('Days of silence before a channel is stale')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(4)
            .setValue(String(getStaleDays()))
            .setPlaceholder('90'),
        ),
      )
    await interaction.showModal(modal)
    return
  }
  if (id.startsWith('sudo:set:edit_modal:')) {
    if (!await requireSudo(interaction)) return
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

  // Defer FIRST — before requireSudo. The sudo check does a
  // `guild.members.fetch()` which can hit the network on a cold cache
  // (common right after a deploy). If that took >3 s before we acked the
  // interaction, Discord killed the interaction with 10062 and the bot
  // looked broken. Now we ack within milliseconds, then take however long
  // requireSudo + render needs (we have 15 min). On sudo failure, the
  // helper falls through to followUp instead of reply (it already handles
  // both branches).
  await interaction.deferUpdate()
  if (!await requireSudo(interaction)) return

  // sudo:set:home
  if (id === 'sudo:set:home') {
    await interaction.editReply(renderHome() as any)
    return
  }

  // sudo:set:nav:{category}
  if (id.startsWith('sudo:set:nav:')) {
    const category = id.slice('sudo:set:nav:'.length)
    if (category === 'sudo_users') {
      await interaction.editReply((await renderSudoUsers()) as any)
    } else if (category === 'channels') {
      await interaction.editReply(renderChannels() as any)
    } else if (category === 'channels_reset') {
      await interaction.editReply(renderChannelsReset() as any)
    } else if (category === 'voice') {
      await interaction.editReply(renderVoice() as any)
    } else if (category === 'hubs') {
      await interaction.editReply(renderHubs() as any)
    } else if (category === 'hub_lockdown') {
      await interaction.editReply((await renderHubLockdown()) as any)
    } else if (category === 'archive') {
      await interaction.editReply((await renderArchive(interaction.client, interaction.guildId!)) as any)
    } else if (category === 'archive_scan_results') {
      await interaction.editReply((await renderArchiveScanResults(interaction.client, interaction.guildId!)) as any)
    } else if (category === 'debug') {
      await interaction.editReply((await renderDebug(interaction.client, interaction.user.id)) as any)
    } else if (category === 'feature_flags') {
      await interaction.editReply((await renderFeatureFlags()) as any)
    } else if (category === 'orphan_scan') {
      await interaction.editReply((await renderOrphanScan(interaction.client, interaction.guildId!)) as any)
    } else if (category === 'heartbeat') {
      await interaction.editReply((await renderHeartbeat(interaction.client)) as any)
    } else if (category === 'staff_history') {
      await interaction.editReply((await renderStaffHistory(interaction.guildId!)) as any)
    } else if (category === 'audit_log') {
      await interaction.editReply((await renderAuditLog()) as any)
    } else if (category === 'usage_stats') {
      await interaction.editReply((await renderUsageStats(interaction.guildId!)) as any)
    } else if (category === 'auto_roles') {
      await interaction.editReply((await renderAutoRoles(interaction.guildId!)) as any)
    } else if (category === 'color_roles') {
      await interaction.editReply((await renderColorRoles(interaction.guildId!)) as any)
    } else if (category === 'welcome') {
      await interaction.editReply((await renderWelcome()) as any)
    } else if (category === 'reaction_roles') {
      await interaction.editReply((await renderReactionRoles()) as any)
    } else if (category === 'report_triage') {
      const { isBotOwner } = await import('../services/botOwner')
      if (!await isBotOwner(interaction.client, interaction.user.id)) {
        await interaction.followUp({ content: '❌ Report triage is bot-owner-only.', flags: MessageFlags.Ephemeral })
        return
      }
      await interaction.editReply((await renderReportTriage(interaction.guildId!)) as any)
    } else if (category === 'auto_threads') {
      await interaction.editReply(renderAutoThreads() as any)
    } else if (category === 'staff_roles') {
      await interaction.editReply(renderStaffRoles(interaction.guild!) as any)
    } else if (category === 'socials') {
      await interaction.editReply((await renderSocials()) as any)
    } else if (category === 'games') {
      await interaction.editReply((await renderGames(interaction.guildId!)) as any)
    } else if (category === 'profiles') {
      await interaction.editReply((await renderProfiles(interaction.guildId!)) as any)
    } else if (category === 'game_defaults') {
      const { renderGameDefaultsPanel } = await import('./gamesEditor')
      await interaction.editReply((await renderGameDefaultsPanel(interaction.guild!)) as any)
    } else {
      await interaction.followUp({ content: `Unknown category: ${category}`, flags: MessageFlags.Ephemeral })
    }
    return
  }

  // sudo:set:staff_roles:provision — create-if-missing + link-by-name + reposition
  if (id === 'sudo:set:staff_roles:provision') {
    const result = await provisionStaffRoles(interaction.guild!, interaction.user.id)
    await interaction.editReply(renderStaffRoles(interaction.guild!) as any)
    const summary: string[] = []
    if (result.created.length)   summary.push(`Created: ${result.created.join(', ')}`)
    if (result.linked.length)    summary.push(`Linked existing: ${result.linked.join(', ')}`)
    if (result.alreadyOk.length) summary.push(`Already OK: ${result.alreadyOk.join(', ')}`)
    if (result.errors.length)    summary.push(`⚠️ Errors: ${result.errors.join('; ')}`)
    await interaction.followUp({ content: summary.length ? summary.join('\n') : '_Nothing to do._', flags: MessageFlags.Ephemeral })
    return
  }

  // sudo:set:staff_roles:clear — clears the linked IDs (Discord roles untouched)
  if (id === 'sudo:set:staff_roles:clear') {
    for (const def of STAFF_ROLE_DEFS) await clearSetting(def.key)
    await interaction.editReply(renderStaffRoles(interaction.guild!) as any)
    return
  }

  // sudo:set:social:toggle:{id} — flip enabled
  if (id.startsWith('sudo:set:social:toggle:')) {
    const feedId = id.slice('sudo:set:social:toggle:'.length)
    const { getSocialFeed, setSocialFeedEnabled } = await import('../services/socialFeeds')
    const feed = getSocialFeed(feedId)
    if (feed) await setSocialFeedEnabled(feedId, !feed.enabled)
    await interaction.editReply((await renderSocialDetail(feedId)) as any)
    return
  }

  // sudo:set:social:test:{id} — fetch + post latest item without marking seen.
  // Already deferred at the top, so we can take the time the fetch needs.
  if (id.startsWith('sudo:set:social:test:')) {
    const feedId = id.slice('sudo:set:social:test:'.length)
    const { getSocialFeed } = await import('../services/socialFeeds')
    const { fetchAndParse, buildSocialPostPayload } = await import('../services/social/poller')
    const feed = getSocialFeed(feedId)
    let note = ''
    if (!feed) {
      note = '⚠️ Feed not found.'
    } else {
      try {
        const items = await fetchAndParse(feed.sourceUrl)
        if (items.length === 0) {
          note = '⚠️ Feed parsed but contained no items.'
        } else {
          const channel = await interaction.client.channels.fetch(feed.channelId).catch(() => null)
          if (!channel || !channel.isTextBased() || channel.isDMBased()) {
            note = `⚠️ Channel <#${feed.channelId}> unavailable.`
          } else {
            await channel.send(buildSocialPostPayload(feed, items[0]) as any)
            note = `✅ Posted latest item to <#${feed.channelId}>.`
          }
        }
      } catch (err) {
        note = `⚠️ ${(err as Error).message}`
      }
    }
    await interaction.editReply((await renderSocialDetail(feedId)) as any)
    await interaction.followUp({ content: note, flags: MessageFlags.Ephemeral }).catch(() => {})
    return
  }

  // sudo:set:social:remove:{id}
  if (id.startsWith('sudo:set:social:remove:')) {
    const feedId = id.slice('sudo:set:social:remove:'.length)
    const { removeSocialFeed } = await import('../services/socialFeeds')
    await removeSocialFeed(feedId)
    await interaction.editReply((await renderSocials()) as any)
    return
  }

  // sudo:set:autothread:set_archive:{channelId}:{minutes|reset} — #27
  if (id.startsWith('sudo:set:autothread:set_archive:')) {
    const rest = id.slice('sudo:set:autothread:set_archive:'.length)
    const lastColon = rest.lastIndexOf(':')
    const channelId = rest.slice(0, lastColon)
    const arg = rest.slice(lastColon + 1)
    const archiveDuration = arg === 'reset' ? null : Number(arg)
    if (arg !== 'reset' && (!Number.isFinite(archiveDuration) || ![60, 1440, 4320, 10080].includes(archiveDuration as number))) {
      await interaction.followUp({ content: '❌ Invalid duration.', flags: MessageFlags.Ephemeral })
      return
    }
    const { updateAutoThreadChannel } = await import('../services/settings')
    await updateAutoThreadChannel(channelId, { archiveDuration })
    await interaction.editReply(renderAutoThreads() as any)
    return
  }

  // #28 — Preview a feed's render style using its last actual item (no post)
  if (id.startsWith('sudo:set:social:preview:')) {
    const feedId = id.slice('sudo:set:social:preview:'.length)
    const { getSocialFeed } = await import('../services/socialFeeds')
    const { fetchAndParse, buildSocialPostPayload } = await import('../services/social/poller')
    const feed = getSocialFeed(feedId)
    if (!feed) {
      await interaction.followUp({ content: '❌ Feed not found.', flags: MessageFlags.Ephemeral })
      return
    }
    try {
      const items = await fetchAndParse(feed.sourceUrl)
      if (items.length === 0) {
        await interaction.followUp({ content: '⚠️ Feed parsed but contained no items.', flags: MessageFlags.Ephemeral })
        return
      }
      const payload = buildSocialPostPayload(feed, items[0])
      await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 } as any)
    } catch (err) {
      await interaction.followUp({ content: `⚠️ Preview failed: ${(err as Error).message}`, flags: MessageFlags.Ephemeral })
    }
    return
  }

  // #18 — sudo:set:profiles:csv_example — send example CSV as an attachment
  if (id === 'sudo:set:profiles:csv_example') {
    const example = [
      '# Bulk birthday import CSV',
      '# Format: user_id,month,day   OR   user_id,MM-DD',
      '# Lines starting with # are ignored. Blank lines are fine.',
      '#',
      '# user_id is the Discord snowflake (right-click a user → Copy User ID,',
      '# requires Developer Mode in Discord settings).',
      '117501528641634310,11,20',
      '484484232199012352,03-15',
      '539266131651854336,2,29',
    ].join('\n')
    await interaction.followUp({
      content: '📄 Example CSV attached. Paste similar content into the **Bulk-import birthdays** modal.',
      files: [{ attachment: Buffer.from(example, 'utf8'), name: 'birthdays.csv' }],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // #34 — sudo:set:debug:clear_caches — bot-owner-only
  if (id === 'sudo:set:debug:clear_caches') {
    const { isBotOwner, invalidateBotOwnerCache } = await import('../services/botOwner')
    if (!await isBotOwner(interaction.client, interaction.user.id)) {
      await interaction.followUp({ content: '❌ Force-clear caches is bot-owner-only.', flags: MessageFlags.Ephemeral })
      return
    }
    const { loadSettings } = await import('../services/settings')
    const { loadGames } = await import('../services/games')
    const { loadSocialFeeds } = await import('../services/socialFeeds')
    invalidateBotOwnerCache()
    await Promise.all([
      loadSettings().catch(err => logger.warn('clear_caches: loadSettings failed', err)),
      loadGames().catch(err => logger.warn('clear_caches: loadGames failed', err)),
      loadSocialFeeds().catch(err => logger.warn('clear_caches: loadSocialFeeds failed', err)),
    ])
    await interaction.editReply((await renderDebug(interaction.client, interaction.user.id)) as any)
    await interaction.followUp({ content: '✅ Caches reloaded: settings, games, social feeds, bot-owner.', flags: MessageFlags.Ephemeral })
    return
  }

  // #16 — sudo:set:debug:cleanup_orphans — bot-owner-only, delete orphaned DB rows
  if (id === 'sudo:set:debug:cleanup_orphans') {
    const { isBotOwner } = await import('../services/botOwner')
    if (!await isBotOwner(interaction.client, interaction.user.id)) {
      await interaction.followUp({ content: '❌ Orphan cleanup is bot-owner-only.', flags: MessageFlags.Ephemeral })
      return
    }
    const guild = interaction.client.guilds.cache.get(interaction.guildId!)
    if (!guild) {
      await interaction.followUp({ content: '❌ Guild not in cache.', flags: MessageFlags.Ephemeral })
      return
    }
    const { db } = await import('../db/client')
    const { autoChannels, hubChannels, autoThreadChannels, archivedChannels } = await import('../db/schema')

    // Delete entirely-orphan rows (where every Discord reference is gone). For
    // partial orphans (e.g. games with only a missing ping_role_id), don't
    // delete — they still have other valid references and the user can edit
    // them via the Games panel.
    const [autoRows, hubRows, threadRows, archivedRows] = await Promise.all([
      db.select().from(autoChannels),
      db.select().from(hubChannels),
      db.select().from(autoThreadChannels),
      db.select().from(archivedChannels),
    ])
    let deleted = 0
    for (const r of autoRows) {
      if (!guild.channels.cache.has(r.voiceChannelId) && !guild.channels.cache.has(r.textChannelId)) {
        await db.delete(autoChannels).where(eq(autoChannels.id, r.id)).catch(() => {}); deleted++
      }
    }
    for (const r of hubRows) {
      if (!guild.channels.cache.has(r.channelId)) {
        await db.delete(hubChannels).where(eq(hubChannels.id, r.id)).catch(() => {}); deleted++
      }
    }
    for (const r of threadRows) {
      if (!guild.channels.cache.has(r.channelId)) {
        await db.delete(autoThreadChannels).where(eq(autoThreadChannels.channelId, r.channelId)).catch(() => {}); deleted++
      }
    }
    for (const r of archivedRows) {
      if (!guild.channels.cache.has(r.channelId)) {
        await db.delete(archivedChannels).where(eq(archivedChannels.channelId, r.channelId)).catch(() => {}); deleted++
      }
    }

    // Reload caches so the in-memory state matches the DB.
    const { loadSettings } = await import('../services/settings')
    await loadSettings().catch(() => {})

    await interaction.editReply((await renderOrphanScan(interaction.client, interaction.guildId!)) as any)
    await interaction.followUp({ content: `✅ Removed **${deleted}** orphan row${deleted === 1 ? '' : 's'}. Games with partially-missing references are left intact — edit those via the Games panel.`, flags: MessageFlags.Ephemeral })
    return
  }

  // #33 — sudo:set:feature:{key} — bot-owner-only toggle
  if (id.startsWith('sudo:set:feature:')) {
    const { isBotOwner } = await import('../services/botOwner')
    if (!await isBotOwner(interaction.client, interaction.user.id)) {
      await interaction.followUp({ content: '❌ Feature flags are bot-owner-only.', flags: MessageFlags.Ephemeral })
      return
    }
    const key = id.slice('sudo:set:feature:'.length)
    const def = FEATURE_FLAGS.find(f => f.key === key)
    if (!def) {
      await interaction.followUp({ content: `Unknown feature flag: ${key}`, flags: MessageFlags.Ephemeral })
      return
    }
    const next = !getBoolSetting(def.key, def.defaultOn)
    await setSetting(def.key, next ? 'true' : 'false', interaction.user.id)
    await interaction.editReply((await renderFeatureFlags()) as any)
    return
  }

  // sudo:set:archive:scan — run the scanner and switch to results panel
  if (id === 'sudo:set:archive:scan') {
    await interaction.editReply((await renderArchiveScanResults(interaction.client, interaction.guildId!)) as any)
    return
  }

  // sudo:set:archive:edit_threshold — modal to set archive.stale_days (numeric setting)
  // The button handler defers first, but showModal can't follow a defer.
  // We handle this BEFORE the deferUpdate at the top — done in a separate
  // branch earlier in the function. See the modal-show branch below if added.

  // sudo:set:hub_lockdown:lock_all:{minutes} — bot-owner-only guild-wide hub lock
  if (id.startsWith('sudo:set:hub_lockdown:lock_all:')) {
    const { isBotOwner } = await import('../services/botOwner')
    if (!await isBotOwner(interaction.client, interaction.user.id)) {
      await interaction.followUp({ content: '❌ Server-wide hub lockdown is bot-owner-only.', flags: MessageFlags.Ephemeral })
      return
    }
    const minutes = Number(id.slice('sudo:set:hub_lockdown:lock_all:'.length))
    if (!Number.isFinite(minutes) || minutes <= 0) {
      await interaction.followUp({ content: '❌ Invalid duration.', flags: MessageFlags.Ephemeral })
      return
    }
    const { lockAllHubs } = await import('../services/voice/hubLockdown')
    const until = new Date(Date.now() + minutes * 60_000)
    await lockAllHubs(interaction.client, interaction.guildId!, until)
    await interaction.editReply((await renderHubLockdown()) as any)
    return
  }

  // sudo:set:hub_lockdown:unlock_all — bot-owner-only
  if (id === 'sudo:set:hub_lockdown:unlock_all') {
    const { isBotOwner } = await import('../services/botOwner')
    if (!await isBotOwner(interaction.client, interaction.user.id)) {
      await interaction.followUp({ content: '❌ Server-wide hub lockdown is bot-owner-only.', flags: MessageFlags.Ephemeral })
      return
    }
    const { unlockAllHubs } = await import('../services/voice/hubLockdown')
    await unlockAllHubs(interaction.client, interaction.guildId!)
    await interaction.editReply((await renderHubLockdown()) as any)
    return
  }

  // sudo:set:bool_toggle:{key} — flip a boolean setting; currently all live in Voice
  if (id.startsWith('sudo:set:bool_toggle:')) {
    const key = id.slice('sudo:set:bool_toggle:'.length)
    // Look up the toggle in the known list; #20 welcome/goodbye keys also flow through here.
    const voiceDef = VOICE_BOOL_SETTINGS.find(d => d.key === key)
    const KNOWN_BOOL_KEYS = new Set<string>([
      ...VOICE_BOOL_SETTINGS.map(d => d.key),
      'welcome.enabled',
      'goodbye.enabled',
    ])
    if (!KNOWN_BOOL_KEYS.has(key)) {
      await interaction.followUp({ content: `Unknown toggle: ${key}`, flags: MessageFlags.Ephemeral })
      return
    }
    const fallback = voiceDef?.defaultValue ?? false
    const next = !getBoolSetting(key, fallback)
    await setSetting(key, next ? 'true' : 'false', interaction.user.id)
    if (key === 'welcome.enabled' || key === 'goodbye.enabled') {
      await interaction.editReply((await renderWelcome()) as any)
    } else {
      await interaction.editReply(renderVoice() as any)
    }
    return
  }

  // sudo:set:reset:{key}  — clear a numeric or voice-side setting override
  if (id.startsWith('sudo:set:reset:')) {
    const key = id.slice('sudo:set:reset:'.length)
    await clearSetting(key)
    // Heuristic: numeric + voice-category settings live in the Voice panel.
    if (NUMERIC_SETTINGS.some(d => d.key === key) || key === VOICE_CATEGORY_SETTING.key) {
      await interaction.editReply(renderVoice() as any)
    } else {
      await interaction.editReply(renderHome() as any)
    }
    return
  }
}

export async function handleSettingsChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  const id = interaction.customId

  if (id === 'sudo:set:autothread:add') {
    const channelId = interaction.values[0]
    let warning: string | null = null
    if (channelId && interaction.guildId) {
      const ch = await interaction.guild?.channels.fetch(channelId).catch(() => null)
      const me = interaction.guild?.members.me
      if (ch && me && 'permissionsFor' in ch) {
        if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) {
          warning = `⚠️ <#${channelId}> is not a text/announcement channel — auto-threading won't run there.`
        } else {
          const perms = (ch as any).permissionsFor(me)
          const missing: string[] = []
          if (!perms?.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel')
          if (!perms?.has(PermissionFlagsBits.CreatePublicThreads)) missing.push('Create Public Threads')
          if (!perms?.has(PermissionFlagsBits.SendMessagesInThreads)) missing.push('Send Messages in Threads')
          if (missing.length > 0) {
            warning = `⚠️ Bot lacks ${missing.join(', ')} in <#${channelId}>. Auto-threading will be skipped until you grant these permissions.`
          }
        }
      }
      await addAutoThreadChannel(channelId, interaction.guildId, interaction.user.id)
    }
    await interaction.update(renderAutoThreads() as any)
    if (warning) {
      await interaction.followUp({ content: warning, flags: MessageFlags.Ephemeral })
    }
    return
  }

  if (id === 'sudo:set:archive:add_eligible') {
    const categoryId = interaction.values[0]
    if (categoryId) {
      const { addEligibleCategory } = await import('../services/archive')
      await addEligibleCategory(interaction.guildId!, categoryId, interaction.user.id)
    }
    await interaction.update((await renderArchive(interaction.client, interaction.guildId!)) as any)
    return
  }

  if (id === 'sudo:set:channel:welcome.channel_id' || id === 'sudo:set:channel:goodbye.channel_id') {
    const key = id.slice('sudo:set:channel:'.length)
    const channelId = interaction.values[0]
    if (channelId) await setSetting(key, channelId, interaction.user.id)
    else           await clearSetting(key, interaction.user.id)
    await interaction.update((await renderWelcome()) as any)
    return
  }

  if (id === 'sudo:set:channel:channel.archive_destination') {
    const channelId = interaction.values[0]
    if (channelId) await setSetting('channel.archive_destination', channelId, interaction.user.id)
    else           await clearSetting('channel.archive_destination')
    await interaction.update((await renderArchive(interaction.client, interaction.guildId!)) as any)
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

export async function handleSettingsRoleSelect(interaction: import('discord.js').RoleSelectMenuInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return
  const id = interaction.customId
  const roleId = interaction.values[0]
  if (!roleId) {
    await interaction.update(id === 'sudo:set:auto_role:add'
      ? (await renderAutoRoles(interaction.guildId!)) as any
      : (await renderColorRoles(interaction.guildId!)) as any)
    return
  }
  const { db } = await import('../db/client')
  if (id === 'sudo:set:auto_role:add') {
    const { autoJoinRoles } = await import('../db/schema')
    await db.insert(autoJoinRoles).values({ roleId, guildId: interaction.guildId!, addedByUserId: interaction.user.id }).onConflictDoNothing()
    await interaction.update((await renderAutoRoles(interaction.guildId!)) as any)
    return
  }
  if (id === 'sudo:set:color_role:add') {
    const role = interaction.guild?.roles.cache.get(roleId)
    const label = role?.name ?? roleId
    const { colorRoles } = await import('../db/schema')
    await db.insert(colorRoles).values({ roleId, guildId: interaction.guildId!, label }).onConflictDoNothing()
    await interaction.update((await renderColorRoles(interaction.guildId!)) as any)
    return
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
    if (userId) await removeSudoUser(userId, interaction.user.id)
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
  if (id === 'sudo:set:hub:edit_defaults') {
    const channelId = interaction.values[0]
    if (!channelId) return
    const hub = listHubs().find(h => h.channelId === channelId)
    if (!hub) {
      await interaction.reply({ content: '❌ Hub not found.', ephemeral: true })
      return
    }
    const modal = new ModalBuilder()
      .setCustomId(`sudo:set:hub:defaults_submit:${channelId}`)
      .setTitle(`Hub defaults — ${hub.label.slice(0, 30)}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('template')
            .setLabel('Template (blank = bot default)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(20)
            .setPlaceholder('auto, counter, squad, detail, state, party, stealth')
            .setValue(hub.defaultTemplateKey ?? '')
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('manual_name')
            .setLabel('Manual name (blank = auto-generated)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(100)
            .setPlaceholder('{member}\'s lounge — supports {member} token')
            .setValue(hub.defaultManualName ?? '')
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('user_limit')
            .setLabel('User limit (0 or blank = no limit)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(2)
            .setPlaceholder('0–99')
            .setValue(hub.defaultUserLimit && hub.defaultUserLimit > 0 ? String(hub.defaultUserLimit) : '')
        ),
      )
    await interaction.showModal(modal)
    return
  }
  if (id === 'sudo:set:social:pick') {
    const feedId = interaction.values[0]
    if (feedId) await interaction.update((await renderSocialDetail(feedId)) as any)
    return
  }
  if (id === 'sudo:set:hub_lockdown:lock_one_pick') {
    const channelId = interaction.values[0]
    if (!channelId) return
    const modal = new ModalBuilder()
      .setCustomId(`sudo:set:hub_lockdown:lock_one_submit:${channelId}`)
      .setTitle('Lock hub')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('minutes')
            .setLabel('Duration in minutes (1–1440)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(4)
            .setPlaceholder('60')
        ),
      )
    await interaction.showModal(modal)
    return
  }
  if (id === 'sudo:set:autothread:edit_template') {
    const channelId = interaction.values[0]
    if (!channelId) return
    const cfg = listAutoThreadChannels().find(c => c.channelId === channelId)
    const modal = new ModalBuilder()
      .setCustomId(`sudo:set:autothread:template_submit:${channelId}`)
      .setTitle('Auto-thread name template')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('template')
            .setLabel('Template (blank to reset to default)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(100)
            .setPlaceholder('{author} — {content}')
            .setValue(cfg?.nameTemplate ?? ''),
        ),
      )
    await interaction.showModal(modal)
    return
  }
  if (id === 'sudo:set:autothread:pick_for_archive') {
    const channelId = interaction.values[0]
    if (!channelId) return
    const cfg = listAutoThreadChannels().find(c => c.channelId === channelId)
    const current = cfg?.archiveDuration
    const lines = [
      '### ⏳ Thread archive duration',
      `Channel: <#${channelId}>`,
      `Current: ${current ? ARCHIVE_DURATION_LABEL[current] ?? `${current}m` : '_default (24h)_'}`,
    ]
    const container = new ContainerBuilder()
      .setAccentColor(0x57f287)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    const presets = [
      { label: '1 hour',   minutes: 60 },
      { label: '24 hours', minutes: 1440 },
      { label: '3 days',   minutes: 4320 },
      { label: '1 week',   minutes: 10080 },
    ]
    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      ...presets.map(p =>
        new ButtonBuilder()
          .setCustomId(`sudo:set:autothread:set_archive:${channelId}:${p.minutes}`)
          .setLabel(p.label)
          .setStyle(current === p.minutes ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
      new ButtonBuilder()
        .setCustomId(`sudo:set:autothread:set_archive:${channelId}:reset`)
        .setLabel('Reset')
        .setEmoji('♻️')
        .setStyle(ButtonStyle.Secondary),
    )
    const back = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('sudo:set:nav:auto_threads').setLabel('Back to Auto Threads').setStyle(ButtonStyle.Secondary),
    )
    await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [container, row, back] } as any)
    return
  }
  if (id === 'sudo:set:hub_lockdown:unlock_one') {
    const channelId = interaction.values[0]
    if (!channelId) return
    const { unlockHub } = await import('../services/voice/hubLockdown')
    await unlockHub(interaction.client, interaction.guildId!, channelId)
    await interaction.update((await renderHubLockdown()) as any)
    return
  }
  if (id === 'sudo:set:reaction_roles:delete') {
    const messageId = interaction.values[0]
    if (messageId) {
      const { deleteReactionRoleMessage } = await import('../services/reactionRoles')
      await deleteReactionRoleMessage(interaction.client, messageId)
    }
    await interaction.update((await renderReactionRoles()) as any)
    return
  }
  if (id === 'sudo:set:auto_role:remove') {
    const roleId = interaction.values[0]
    if (roleId) {
      const { db } = await import('../db/client')
      const { autoJoinRoles } = await import('../db/schema')
      await db.delete(autoJoinRoles).where(eq(autoJoinRoles.roleId, roleId))
    }
    await interaction.update((await renderAutoRoles(interaction.guildId!)) as any)
    return
  }
  if (id === 'sudo:set:color_role:remove') {
    const roleId = interaction.values[0]
    if (roleId) {
      const { db } = await import('../db/client')
      const { colorRoles } = await import('../db/schema')
      await db.delete(colorRoles).where(eq(colorRoles.roleId, roleId))
    }
    await interaction.update((await renderColorRoles(interaction.guildId!)) as any)
    return
  }
  if (id === 'sudo:set:archive:remove_eligible') {
    const categoryId = interaction.values[0]
    if (categoryId) {
      const { removeEligibleCategory } = await import('../services/archive')
      await removeEligibleCategory(categoryId)
    }
    await interaction.update((await renderArchive(interaction.client, interaction.guildId!)) as any)
    return
  }
  if (id === 'sudo:set:archive:unarchive') {
    const channelId = interaction.values[0]
    if (!channelId) return
    const { unarchiveChannel } = await import('../services/archive')
    const result = await unarchiveChannel(interaction.client, channelId)
    await interaction.update((await renderArchive(interaction.client, interaction.guildId!)) as any)
    if (!result.ok) {
      await interaction.followUp({ content: `⚠️ Unarchive failed: ${result.reason}`, flags: MessageFlags.Ephemeral })
    }
    return
  }
  if (id === 'sudo:set:archive:scan_pick') {
    await interaction.deferUpdate()
    const { archiveChannel } = await import('../services/archive')
    const results: { id: string; ok: boolean; reason?: string }[] = []
    for (const channelId of interaction.values) {
      const r = await archiveChannel(interaction.client, interaction.guildId!, channelId, interaction.user.id)
      results.push({ id: channelId, ok: r.ok, reason: r.ok ? undefined : r.reason })
    }
    const ok = results.filter(r => r.ok).length
    const fail = results.filter(r => !r.ok)
    await interaction.editReply((await renderArchive(interaction.client, interaction.guildId!)) as any)
    const summary = `Archived **${ok}**${fail.length > 0 ? ` · Failed **${fail.length}**:\n` + fail.map(f => `<#${f.id}> — ${f.reason}`).join('\n') : ''}`
    await interaction.followUp({ content: summary, flags: MessageFlags.Ephemeral })
    return
  }
}

export async function handleSettingsModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return

  // #37 — Create reaction-role message
  if (interaction.customId === 'sudo:set:reaction_roles:create_submit') {
    const channelId = interaction.fields.getTextInputValue('channel_id').trim()
    const body = interaction.fields.getTextInputValue('body')
    const mappingsRaw = interaction.fields.getTextInputValue('mappings').trim()
    const expiresRaw = interaction.fields.getTextInputValue('expires_minutes').trim()

    if (!/^\d{15,25}$/.test(channelId)) {
      await interaction.reply({ content: '❌ Channel ID must be a Discord snowflake.', ephemeral: true })
      return
    }
    const channel = await interaction.guild?.channels.fetch(channelId).catch(() => null)
    if (!channel?.isTextBased()) {
      await interaction.reply({ content: '❌ That channel is not text-based or not accessible.', ephemeral: true })
      return
    }

    const mappings: { emoji: string; roleId: string }[] = []
    for (const line of mappingsRaw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
      const eqIdx = line.indexOf('=')
      if (eqIdx < 1) {
        await interaction.reply({ content: `❌ Bad mapping line: \`${line}\` (use \`emoji=roleId\`).`, ephemeral: true })
        return
      }
      const emojiRaw = line.slice(0, eqIdx).trim()
      const roleId = line.slice(eqIdx + 1).trim()
      if (!/^\d{15,25}$/.test(roleId)) {
        await interaction.reply({ content: `❌ Bad roleId: \`${roleId}\`.`, ephemeral: true })
        return
      }
      // For custom emojis in <a?:name:id> form, extract just the id.
      const customMatch = emojiRaw.match(/<a?:[^:]+:(\d+)>/)
      mappings.push({ emoji: customMatch ? customMatch[1] : emojiRaw, roleId })
    }
    if (mappings.length === 0) {
      await interaction.reply({ content: '❌ At least one mapping is required.', ephemeral: true })
      return
    }

    let expiresAt: Date | null = null
    if (expiresRaw) {
      const n = Number(expiresRaw)
      if (!Number.isFinite(n) || n < 1 || n > 60 * 24 * 30) {
        await interaction.reply({ content: '❌ Expires must be 1–43200 minutes (30 days).', ephemeral: true })
        return
      }
      expiresAt = new Date(Date.now() + n * 60_000)
    }

    await interaction.deferReply({ ephemeral: true })
    const { createReactionRoleMessage } = await import('../services/reactionRoles')
    try {
      const cfg = await createReactionRoleMessage(channel as any, body, mappings, {
        expiresAt,
        createdByUserId: interaction.user.id,
      })
      await interaction.editReply({ content: `✅ Created reaction-role message \`${cfg.messageId}\` in <#${channelId}> with ${mappings.length} mapping(s)${expiresAt ? ` — expires <t:${Math.floor(expiresAt.getTime() / 1000)}:R>` : ''}.` })
    } catch (err) {
      await interaction.editReply({ content: `❌ Failed: ${(err as Error).message}` })
    }
    return
  }

  // #20 — Welcome/goodbye template submit
  if (interaction.customId === 'sudo:set:welcome:welcome_submit' || interaction.customId === 'sudo:set:welcome:goodbye_submit') {
    const which = interaction.customId === 'sudo:set:welcome:welcome_submit' ? 'welcome' : 'goodbye'
    const raw = interaction.fields.getTextInputValue('template').trim()
    if (raw === '') {
      await clearSetting(`${which}.template`, interaction.user.id)
    } else {
      await setSetting(`${which}.template`, raw, interaction.user.id)
    }
    await interaction.reply({ content: raw === '' ? `✅ ${which} template reset to default.` : `✅ ${which} template saved.`, ephemeral: true })
    return
  }

  // #29 — Save per-feed throttle
  if (interaction.customId.startsWith('sudo:set:social:throttle_submit:')) {
    const feedId = interaction.customId.slice('sudo:set:social:throttle_submit:'.length)
    const raw = interaction.fields.getTextInputValue('n').trim()
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0 || n > 50) {
      await interaction.reply({ content: '❌ Must be an integer 0–50.', ephemeral: true })
      return
    }
    // Sudo cap is 3 per spec; bot owner can go higher.
    const { isBotOwner } = await import('../services/botOwner')
    if (n > 3 && !await isBotOwner(interaction.client, interaction.user.id)) {
      await interaction.reply({ content: '❌ Sudo cap on max items is 3. Only a bot owner can set higher.', ephemeral: true })
      return
    }
    const { setSocialFeedMaxItems } = await import('../services/socialFeeds')
    await setSocialFeedMaxItems(feedId, n)
    await interaction.reply({ content: `✅ Max items per poll set to **${n}**.`, ephemeral: true })
    return
  }

  // #18 — Bulk-import birthdays CSV
  if (interaction.customId === 'sudo:set:profiles:csv_submit') {
    const raw = interaction.fields.getTextInputValue('csv')
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    const { db } = await import('../db/client')
    const { userProfiles } = await import('../db/schema')

    let imported = 0
    const errors: string[] = []

    for (const [i, line] of lines.entries()) {
      // Split on commas; tolerate "MM-DD" combined too.
      const parts = line.split(',').map(p => p.trim()).filter(Boolean)
      if (parts.length < 2) { errors.push(`L${i + 1}: not enough fields — \`${line}\``); continue }
      const userIdRaw = parts[0].replace(/[<@!>]/g, '')
      if (!/^\d{15,25}$/.test(userIdRaw)) { errors.push(`L${i + 1}: bad user_id \`${userIdRaw}\``); continue }

      let month: number, day: number
      if (parts.length >= 3) {
        month = Number(parts[1]); day = Number(parts[2])
      } else {
        const md = parts[1].split(/[-/]/)
        if (md.length !== 2) { errors.push(`L${i + 1}: bad date \`${parts[1]}\``); continue }
        month = Number(md[0]); day = Number(md[1])
      }
      if (!Number.isInteger(month) || month < 1 || month > 12) { errors.push(`L${i + 1}: bad month \`${month}\``); continue }
      if (!Number.isInteger(day) || day < 1 || day > 31) { errors.push(`L${i + 1}: bad day \`${day}\``); continue }

      await db.insert(userProfiles)
        .values({ guildId: interaction.guildId!, userId: userIdRaw, birthdayMonth: month, birthdayDay: day })
        .onConflictDoUpdate({
          target: [userProfiles.guildId, userProfiles.userId],
          set: { birthdayMonth: month, birthdayDay: day },
        })
      imported++
    }

    const lines2 = [`✅ Imported **${imported}** birthday row${imported === 1 ? '' : 's'}.`]
    if (errors.length > 0) {
      lines2.push(`⚠️ **${errors.length}** error${errors.length === 1 ? '' : 's'}:`)
      lines2.push(...errors.slice(0, 15))
      if (errors.length > 15) lines2.push(`_…and ${errors.length - 15} more._`)
    }
    await interaction.reply({ content: lines2.join('\n'), ephemeral: true })
    return
  }

  // #26 Auto-thread template editor — modal submit
  if (interaction.customId.startsWith('sudo:set:autothread:template_submit:')) {
    const channelId = interaction.customId.slice('sudo:set:autothread:template_submit:'.length)
    const raw = interaction.fields.getTextInputValue('template').trim()
    const nameTemplate = raw.length > 0 ? raw : null
    const { updateAutoThreadChannel } = await import('../services/settings')
    await updateAutoThreadChannel(channelId, { nameTemplate })
    await interaction.reply({ content: nameTemplate ? `✅ Template set to \`${nameTemplate}\`.` : '✅ Template reset to default.', ephemeral: true })
    return
  }

  // Archive: set the stale-threshold (days)
  if (interaction.customId === 'sudo:set:archive:edit_threshold_submit') {
    const raw = interaction.fields.getTextInputValue('days').trim()
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      await interaction.reply({ content: '❌ Days must be an integer 1–3650 (10 years max).', ephemeral: true })
      return
    }
    await setSetting('archive.stale_days', String(n), interaction.user.id)
    await interaction.reply({ content: `✅ Stale threshold set to **${n}** days.`, ephemeral: true })
    return
  }

  // Per-hub lockdown modal — sets lockdown_until on a single hub.
  if (interaction.customId.startsWith('sudo:set:hub_lockdown:lock_one_submit:')) {
    const channelId = interaction.customId.slice('sudo:set:hub_lockdown:lock_one_submit:'.length)
    const raw = interaction.fields.getTextInputValue('minutes').trim()
    const minutes = Number(raw)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      await interaction.reply({ content: '❌ Duration must be an integer 1–1440 (minutes).', ephemeral: true })
      return
    }
    const { lockHub } = await import('../services/voice/hubLockdown')
    const until = new Date(Date.now() + minutes * 60_000)
    await lockHub(interaction.client, interaction.guildId!, channelId, until)
    await interaction.reply({ content: `✅ Hub locked until <t:${Math.floor(until.getTime() / 1000)}:R>.`, ephemeral: true })
    return
  }

  // Per-hub defaults editor modal — sets template / manual name / user limit on hub_channels.
  if (interaction.customId.startsWith('sudo:set:hub:defaults_submit:')) {
    const channelId = interaction.customId.slice('sudo:set:hub:defaults_submit:'.length)
    const rawTemplate = interaction.fields.getTextInputValue('template').trim().toLowerCase()
    const rawName     = interaction.fields.getTextInputValue('manual_name').trim()
    const rawLimit    = interaction.fields.getTextInputValue('user_limit').trim()

    const ALLOWED_TEMPLATES = new Set(['auto', 'counter', 'squad', 'detail', 'state', 'party', 'stealth'])
    if (rawTemplate && !ALLOWED_TEMPLATES.has(rawTemplate)) {
      await interaction.reply({ content: `❌ Template must be one of: ${[...ALLOWED_TEMPLATES].join(', ')}. Got: \`${rawTemplate}\``, ephemeral: true })
      return
    }
    let parsedLimit: number | null = null
    if (rawLimit) {
      const n = Number(rawLimit)
      if (!Number.isInteger(n) || n < 0 || n > 99) {
        await interaction.reply({ content: '❌ User limit must be an integer 0–99.', ephemeral: true })
        return
      }
      parsedLimit = n
    }

    const { setHubDefaults } = await import('../services/settings')
    await setHubDefaults(channelId, {
      templateKey: rawTemplate || null,
      manualName: rawName || null,
      userLimit: parsedLimit,
    })
    await interaction.reply({ content: '✅ Hub defaults saved. They\'ll apply on the next hub join.', ephemeral: true })
    return
  }

  // Social feed Add Feed modal — separate code path (not a generic key/value setting).
  if (interaction.customId === 'sudo:set:social:add_submit') {
    const label = interaction.fields.getTextInputValue('label').trim()
    const url   = interaction.fields.getTextInputValue('url').trim()
    const channelInput = interaction.fields.getTextInputValue('channel_id').trim()
    const channelId = channelInput || SOCIAL_DEFAULT_CHANNEL_ID

    if (!/^https?:\/\//i.test(url)) {
      await interaction.reply({ content: '❌ URL must start with http:// or https://', ephemeral: true })
      return
    }
    if (!/^\d{15,25}$/.test(channelId)) {
      await interaction.reply({ content: `❌ Channel ID must be a Discord snowflake (numeric). Got: \`${channelId}\``, ephemeral: true })
      return
    }

    const { addSocialFeed, markSocialFeedSeen } = await import('../services/socialFeeds')
    const { fetchAndParse } = await import('../services/social/poller')

    let seedGuid: string | null = null
    let seedNote = '_(no items yet — first poll will seed the dedupe key)_'
    try {
      const items = await fetchAndParse(url)
      if (items.length > 0) {
        seedGuid = items[0].guid
        seedNote = `_(seeded from \`${seedGuid.slice(0, 40)}${seedGuid.length > 40 ? '…' : ''}\` — backlog won't be replayed)_`
      }
    } catch (err) {
      seedNote = `_(initial fetch failed: ${(err as Error).message} — feed saved anyway, will retry on next poll)_`
    }

    const feed = await addSocialFeed({
      guildId: interaction.guildId!,
      label,
      sourceUrl: url,
      channelId,
      createdByDiscordId: interaction.user.id,
      seedLastSeenId: seedGuid,
    })
    if (seedGuid) await markSocialFeedSeen(feed.id, seedGuid).catch(() => {})

    if (interaction.isFromMessage()) {
      await interaction.update((await renderSocials()) as any)
    } else {
      await interaction.reply({ content: `✅ Added **${label}** → <#${channelId}>. ${seedNote}`, ephemeral: true })
    }
    return
  }

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
