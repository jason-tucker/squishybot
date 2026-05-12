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
import { isNotNull, or } from 'drizzle-orm'
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
  )
  const navRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('sudo:home').setLabel('Back to /sudo').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
  )

  return { flags: MessageFlags.IsComponentsV2 as number, components: [container, row1, row2, row3, navRow] }
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
    const def = VOICE_BOOL_SETTINGS.find(d => d.key === key)
    if (!def) {
      await interaction.followUp({ content: `Unknown toggle: ${key}`, flags: MessageFlags.Ephemeral })
      return
    }
    const next = !getBoolSetting(def.key, def.defaultValue)
    await setSetting(def.key, next ? 'true' : 'false', interaction.user.id)
    await interaction.editReply(renderVoice() as any)
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
  if (id === 'sudo:set:hub_lockdown:unlock_one') {
    const channelId = interaction.values[0]
    if (!channelId) return
    const { unlockHub } = await import('../services/voice/hubLockdown')
    await unlockHub(interaction.client, interaction.guildId!, channelId)
    await interaction.update((await renderHubLockdown()) as any)
    return
  }
}

export async function handleSettingsModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (!await requireSudo(interaction)) return

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
