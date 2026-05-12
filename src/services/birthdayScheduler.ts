/**
 * Birthday pings — once a day, post a celebratory message in the configured
 * birthday channel for each member whose birthday falls on today's date and
 * who hasn't opted out via /profile (`birthday_pings_enabled`).
 *
 * Idempotency: `bot_settings` key `birthday.last_run_date` (YYYY-MM-DD).
 * The scheduler ticks once a minute, but only fires when the configured
 * target hour is reached AND the date has changed since the last run.
 *
 * Configurable settings (all editable via /sudo → Settings):
 *   - channel.birthday              destination channel
 *   - birthday.target_hour          hour-of-day to fire (0–23, default 9)
 *
 * Leap-year handling: Feb 29 birthdays receive a ping on Feb 28 in non-leap
 * years (with a small note). This keeps "your birthday gets celebrated" true
 * for everyone every year.
 */
import type { Client } from 'discord.js'
import { ChannelType } from 'discord.js'
import { env } from '../config/env'
import { logger } from './logger'
import { getSetting, setSetting, settingOrNumber } from './settings'
import { findBirthdayUsers } from './userProfile'

const TICK_MS = 60_000  // every minute
const LAST_RUN_KEY = 'birthday.last_run_date'
const TARGET_HOUR_KEY = 'birthday.target_hour'

let interval: NodeJS.Timeout | null = null

export function startBirthdayScheduler(client: Client): void {
  if (interval) return
  interval = setInterval(() => {
    void tick(client).catch(err => logger.error('Birthday scheduler tick failed', err))
  }, TICK_MS)
  logger.info('Birthday scheduler started — ticking every 60s')
}

export function stopBirthdayScheduler(): void {
  if (!interval) return
  clearInterval(interval)
  interval = null
}

function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

async function tick(client: Client): Promise<void> {
  const targetHour = settingOrNumber(TARGET_HOUR_KEY, 9)
  const now = new Date()
  if (now.getHours() !== targetHour) return

  const today = isoDate(now)
  const lastRun = getSetting(LAST_RUN_KEY)
  if (lastRun === today) return

  await runForDate(client, now)
  await setSetting(LAST_RUN_KEY, today)
}

/** Public entry — used by tick() and exported for manual /sudo trigger. */
export async function runForDate(client: Client, date: Date): Promise<{ posted: number; skipped: number }> {
  // Feature flag (#33).
  const { getBoolSetting } = await import('./settings')
  if (!getBoolSetting('feature.birthday_pings', true)) return { posted: 0, skipped: 0 }
  const guildId = env.GUILD_ID
  const guild = client.guilds.cache.get(guildId)
  if (!guild) {
    logger.warn(`Birthday scheduler: guild ${guildId} not in cache — skipping`)
    return { posted: 0, skipped: 0 }
  }

  const month = date.getMonth() + 1
  const day = date.getDate()

  const birthdayUsers = await findBirthdayUsers(guildId, month, day)

  // Feb 28 in a non-leap year: also fire Feb 29 birthdays so they don't miss out.
  let coveredFeb29: typeof birthdayUsers = []
  if (month === 2 && day === 28 && !isLeapYear(date.getFullYear())) {
    coveredFeb29 = await findBirthdayUsers(guildId, 2, 29)
  }

  const allUsers = [...birthdayUsers, ...coveredFeb29]
  if (allUsers.length === 0) {
    return { posted: 0, skipped: 0 }
  }

  const channelId = getSetting('channel.birthday') ?? env.BIRTHDAY_CHANNEL_ID
  if (!channelId) {
    logger.warn(`Birthday scheduler: ${allUsers.length} birthday(s) today but channel.birthday is unset — skipping`)
    return { posted: 0, skipped: allUsers.length }
  }

  const channel = await client.channels.fetch(channelId).catch(() => null)
  if (!channel || channel.type !== ChannelType.GuildText) {
    logger.warn(`Birthday scheduler: channel ${channelId} is not a text channel — skipping`)
    return { posted: 0, skipped: allUsers.length }
  }

  // Bulk-fetch all candidate members in one REST call so the loop only has to
  // consult the cache for membership.
  const userIds = allUsers.map(u => u.userId)
  const fetched = await guild.members.fetch({ user: userIds }).catch(() => null)

  let posted = 0
  let skipped = 0
  for (const u of allUsers) {
    if (!fetched?.has(u.userId)) {
      skipped++
      continue
    }
    const isFeb29 = u.birthdayMonth === 2 && u.birthdayDay === 29
    const note = isFeb29 && !(month === 2 && day === 29) ? ' _(celebrating early — leap-year birthday!)_' : ''
    const flavors = [
      `🎂 Happy birthday, <@${u.userId}>! 🎉${note}`,
      `🎈 It's <@${u.userId}>'s birthday today! 🎂${note}`,
      `🎉 Big birthday wishes to <@${u.userId}>! 🥳${note}`,
    ]
    const message = flavors[Math.floor(Math.random() * flavors.length)]
    try {
      await channel.send({ content: message })
      posted++
    } catch (err) {
      logger.error(`Birthday scheduler: failed to post for ${u.userId}`, err)
      skipped++
    }
  }

  logger.info(`Birthday scheduler: posted=${posted} skipped=${skipped} on ${month}/${day}`)
  return { posted, skipped }
}
