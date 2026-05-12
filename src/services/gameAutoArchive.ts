/**
 * #21 — Daily check that auto-archives game channels older than each game's
 * auto_archive_days setting. Default OFF (no game has a value by default).
 * Uses the existing archive workflow (#15) so the destination category and
 * unarchive flow are shared.
 */
import { ChannelType, type Client, type TextChannel } from 'discord.js'
import { listGames } from './games'
import { archiveChannel } from './archive'
import { logger } from './logger'

const TICK_MS = 12 * 60 * 60 * 1000  // every 12h
let timer: NodeJS.Timeout | null = null

export function startGameAutoArchiver(client: Client, guildId: string): void {
  if (timer) clearInterval(timer)
  setTimeout(() => { void runOnce(client, guildId) }, 60_000)  // first run 1 min after boot
  timer = setInterval(() => { void runOnce(client, guildId) }, TICK_MS)
  logger.info(`Game auto-archiver started — tick=${Math.round(TICK_MS / 1000)}s`)
}

async function runOnce(client: Client, guildId: string): Promise<void> {
  const guild = client.guilds.cache.get(guildId)
  if (!guild) return
  const eligible = listGames().filter(g => g.guildId === guildId && g.channelId && g.autoArchiveDays && g.autoArchiveDays > 0)
  if (eligible.length === 0) return
  const now = Date.now()
  let archived = 0
  for (const g of eligible) {
    const channel = guild.channels.cache.get(g.channelId!)
    if (!channel || channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) continue
    const lastMsgId = (channel as TextChannel).lastMessageId
    let lastAt = 0
    if (lastMsgId) {
      try { lastAt = Number((BigInt(lastMsgId) >> 22n) + 1420070400000n) } catch {}
    }
    const cutoff = now - (g.autoArchiveDays as number) * 24 * 60 * 60 * 1000
    if (lastAt < cutoff) {
      const result = await archiveChannel(client, guildId, g.channelId!)
      if (result.ok) archived++
      else logger.warn(`game auto-archive: ${g.name} (${g.channelId}) — ${result.reason}`)
    }
  }
  if (archived > 0) logger.info(`Game auto-archive tick: archived ${archived} channel(s)`)
}
