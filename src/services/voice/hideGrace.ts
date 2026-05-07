/**
 * Hide-grace timers — when a non-sudo, non-owner/host member disconnects from
 * a hidden auto voice channel, grant them a short-lived ViewChannel allow on
 * the channel so they can rejoin if the disconnect was a network blip. The
 * allow is removed automatically when the grace expires.
 *
 * Owner/hosts/sudo already have permanent ViewChannel allows applied when the
 * channel is hidden, so they never need this. Bots are skipped at the call
 * site.
 *
 * State is in-memory only — on a bot restart, in-flight graces are dropped.
 * That's fine: the user is still connected (or already disconnected past the
 * grace window) by the time the bot is back, and the next disconnect will
 * grant a fresh window.
 */
import type { VoiceBasedChannel } from 'discord.js'
import { logger } from '../logger'

export const HIDE_GRACE_MS = 90_000

const timers = new Map<string, NodeJS.Timeout>()

function key(vcId: string, userId: string): string {
  return `${vcId}:${userId}`
}

export async function grantHideGrace(vc: VoiceBasedChannel, userId: string): Promise<void> {
  const k = key(vc.id, userId)
  const existing = timers.get(k)
  if (existing) clearTimeout(existing)

  await vc.permissionOverwrites.edit(userId, { ViewChannel: true })
    .catch(err => logger.warn(`hide-grace: failed to grant view to ${userId} on vc=${vc.id}: ${err?.message ?? err}`))

  const timer = setTimeout(async () => {
    timers.delete(k)
    try {
      const ch = await vc.guild.channels.fetch(vc.id).catch(() => null)
      if (!ch?.isVoiceBased()) return
      await ch.permissionOverwrites.delete(userId).catch(() => {})
    } catch (err) {
      logger.warn(`hide-grace: cleanup failed for ${userId}/${vc.id}:`, err)
    }
  }, HIDE_GRACE_MS)
  timers.set(k, timer)
  logger.info(`hide-grace: granted ${HIDE_GRACE_MS / 1000}s view to ${userId} on vc=${vc.id}`)
}

/** Cancel a pending grace timer for one (vc, user). Used when the user is upgraded mid-grace (e.g. promoted to host). */
export function cancelHideGrace(vcId: string, userId: string): void {
  const k = key(vcId, userId)
  const t = timers.get(k)
  if (t) {
    clearTimeout(t)
    timers.delete(k)
  }
}

/** Cancel every pending grace timer for a VC. Call this from deleteAutoChannel so we don't try to edit a deleted channel. */
export function cancelAllHideGracesFor(vcId: string): void {
  const prefix = `${vcId}:`
  for (const k of [...timers.keys()]) {
    if (k.startsWith(prefix)) {
      clearTimeout(timers.get(k)!)
      timers.delete(k)
    }
  }
}
