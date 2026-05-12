/**
 * Hub lockdown — temporary kill switch for one or all hubs.
 *
 * Per the spec: bot owner can lock guild-wide; sudo can lock individual
 * hubs. When a hub is locked, the bot denies Connect on @everyone for the
 * underlying voice channel so Discord blocks joins entirely. The bot
 * restores Connect when the lockdown timestamp passes.
 *
 * State persists across restarts:
 *   - per-hub:    hub_channels.lockdown_until
 *   - guild-wide: bot_settings key `voice.guild_lockdown_until`
 * On boot, `restoreHubLockdowns(client)` re-applies any in-flight denials and
 * schedules unlock timers (or clears already-expired rows).
 */
import { ChannelType, type Client } from 'discord.js'
import { db } from '../../db/client'
import { hubChannels } from '../../db/schema'
import { eq } from 'drizzle-orm'
import { logger } from '../logger'
import { clearSetting, getSetting, setSetting } from '../settings'
import { env } from '../../config/env'
import {
  publish,
  voiceCh,
  type VoiceLockdownStartedEvent,
  type VoiceLockdownEndedEvent,
} from '../eventBus'

const SERVER_LOCKDOWN_KEY = 'voice.guild_lockdown_until'
const SERVER_TIMER_KEY = '__server__'

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

async function applyHubConnect(
  client: Client,
  guildId: string,
  channelId: string,
  allow: boolean,
): Promise<void> {
  const guild = client.guilds.cache.get(guildId)
  if (!guild) return
  const channel = guild.channels.cache.get(channelId)
    ?? await guild.channels.fetch(channelId).catch(() => null)
  if (!channel || channel.type !== ChannelType.GuildVoice) return
  await channel.permissionOverwrites.edit(guild.roles.everyone, {
    Connect: allow ? null : false,
  }).catch(err => logger.warn(`hubLockdown: failed to ${allow ? 'unlock' : 'lock'} hub ${channelId}: ${err?.message ?? err}`))
}

function cancelTimer(key: string): void {
  const t = pendingTimers.get(key)
  if (t) {
    clearTimeout(t)
    pendingTimers.delete(key)
  }
}

export async function lockHub(client: Client, guildId: string, channelId: string, until: Date): Promise<void> {
  await db.update(hubChannels).set({ lockdownUntil: until }).where(eq(hubChannels.channelId, channelId))
  await applyHubConnect(client, guildId, channelId, false)
  cancelTimer(channelId)
  const remaining = Math.max(0, until.getTime() - Date.now())
  pendingTimers.set(channelId, setTimeout(() => {
    pendingTimers.delete(channelId)
    void unlockHub(client, guildId, channelId)
  }, remaining))
  logger.info(`Hub ${channelId} locked until ${until.toISOString()}`)
  void publish<VoiceLockdownStartedEvent>(voiceCh('lockdown_started'), {
    hubChannelId: channelId,
    until: until.toISOString(),
    ts: new Date().toISOString(),
  })
}

export async function unlockHub(client: Client, guildId: string, channelId: string): Promise<void> {
  await db.update(hubChannels).set({ lockdownUntil: null }).where(eq(hubChannels.channelId, channelId))
  cancelTimer(channelId)
  // Don't restore Connect if the server-wide lockdown is still active —
  // per-hub unlock should not punch a hole in the guild-wide policy.
  const serverLock = getServerLockUntil()
  if (!serverLock || serverLock <= new Date()) {
    await applyHubConnect(client, guildId, channelId, true)
  }
  logger.info(`Hub ${channelId} unlocked`)
  void publish<VoiceLockdownEndedEvent>(voiceCh('lockdown_ended'), {
    hubChannelId: channelId,
    ts: new Date().toISOString(),
  })
}

export async function lockAllHubs(client: Client, guildId: string, until: Date): Promise<void> {
  await setSetting(SERVER_LOCKDOWN_KEY, until.toISOString())
  const hubs = await db.select().from(hubChannels).where(eq(hubChannels.guildId, guildId))
  for (const h of hubs) {
    await applyHubConnect(client, guildId, h.channelId, false)
  }
  cancelTimer(SERVER_TIMER_KEY)
  const remaining = Math.max(0, until.getTime() - Date.now())
  pendingTimers.set(SERVER_TIMER_KEY, setTimeout(() => {
    pendingTimers.delete(SERVER_TIMER_KEY)
    void unlockAllHubs(client, guildId)
  }, remaining))
  logger.info(`All hubs in guild ${guildId} locked until ${until.toISOString()}`)
  void publish<VoiceLockdownStartedEvent>(voiceCh('lockdown_started'), {
    guildWide: true,
    until: until.toISOString(),
    ts: new Date().toISOString(),
  })
}

export async function unlockAllHubs(client: Client, guildId: string): Promise<void> {
  await clearSetting(SERVER_LOCKDOWN_KEY)
  cancelTimer(SERVER_TIMER_KEY)
  const hubs = await db.select().from(hubChannels).where(eq(hubChannels.guildId, guildId))
  const now = new Date()
  for (const h of hubs) {
    // Preserve individual-hub lockdowns that are still in effect.
    if (h.lockdownUntil && h.lockdownUntil > now) continue
    await applyHubConnect(client, guildId, h.channelId, true)
  }
  logger.info(`Guild ${guildId} hub lockdown lifted`)
  void publish<VoiceLockdownEndedEvent>(voiceCh('lockdown_ended'), {
    guildWide: true,
    ts: new Date().toISOString(),
  })
}

export function getServerLockUntil(): Date | null {
  const v = getSetting(SERVER_LOCKDOWN_KEY)
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return d > new Date() ? d : null
}

/**
 * Boot-time restore: re-applies any in-flight Connect denials and reschedules
 * unlock timers. Cleans up rows whose lockdown already expired while the bot
 * was down.
 */
export async function restoreHubLockdowns(client: Client): Promise<void> {
  const now = new Date()

  const serverUntilStr = getSetting(SERVER_LOCKDOWN_KEY)
  if (serverUntilStr) {
    const d = new Date(serverUntilStr)
    if (Number.isNaN(d.getTime()) || d <= now) {
      await clearSetting(SERVER_LOCKDOWN_KEY)
    } else {
      const hubs = await db.select().from(hubChannels).where(eq(hubChannels.guildId, env.GUILD_ID))
      for (const h of hubs) await applyHubConnect(client, env.GUILD_ID, h.channelId, false)
      cancelTimer(SERVER_TIMER_KEY)
      const remaining = d.getTime() - now.getTime()
      pendingTimers.set(SERVER_TIMER_KEY, setTimeout(() => {
        pendingTimers.delete(SERVER_TIMER_KEY)
        void unlockAllHubs(client, env.GUILD_ID)
      }, remaining))
      logger.info(`Restored guild-wide hub lockdown — expires ${d.toISOString()}`)
    }
  }

  const hubs = await db.select().from(hubChannels)
  for (const h of hubs) {
    if (!h.lockdownUntil) continue
    if (h.lockdownUntil > now) {
      await applyHubConnect(client, h.guildId, h.channelId, false)
      cancelTimer(h.channelId)
      const remaining = h.lockdownUntil.getTime() - now.getTime()
      const channelId = h.channelId, guildId = h.guildId
      pendingTimers.set(channelId, setTimeout(() => {
        pendingTimers.delete(channelId)
        void unlockHub(client, guildId, channelId)
      }, remaining))
      logger.info(`Restored hub lockdown for ${h.channelId} — expires ${h.lockdownUntil.toISOString()}`)
    } else {
      // Expired while bot was down — clear DB and restore Connect (unless the
      // server-wide policy is in force, in which case unlockHub guards it).
      await unlockHub(client, h.guildId, h.channelId)
    }
  }
}
