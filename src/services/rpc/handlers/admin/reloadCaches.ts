/**
 * `admin.reload_caches` — bot-owner-triggered force-clear of in-memory caches.
 *
 * Mirrors the existing `/sudo → Settings → Debug → Force-clear caches` button
 * (#34, see `src/interactions/sudoSettings.ts` handler for
 * `sudo:set:debug:clear_caches`). Reuses the exact same set of loaders so the
 * Discord button and the panel button stay in lock-step — if a fifth cache
 * is ever added, update both sites.
 *
 * Reply shape: `{ ok: true, data: { reloaded: string[] } }` listing the cache
 * names that were refreshed. Individual loader failures don't fail the whole
 * verb — each one logs and we still report what attempted to reload, so the
 * operator sees which caches the bot tried to touch (the panel renders the
 * list verbatim into the success strip).
 *
 * No params are accepted — the verb is a "do the whole thing" button.
 */
import { registerVerb, type VerbHandler } from '../../registry'
import { logger } from '../../../logger'

export const reloadCachesHandler: VerbHandler = async (_params, _ctx) => {
  const { loadSettings } = await import('../../../settings')
  const { loadGames } = await import('../../../games')
  const { loadSocialFeeds } = await import('../../../socialFeeds')
  const { invalidateBotOwnerCache } = await import('../../../botOwner')

  // Run in parallel — these caches don't depend on each other.
  // Each `.catch` is intentionally swallowing: a failed reload is noted in
  // the bot log but doesn't fail the verb because partial success is still
  // useful (e.g. settings reloaded but socialFeeds DB blip would otherwise
  // mask the settings success in the operator's eyes).
  await Promise.all([
    loadSettings().catch((err) => logger.warn('admin.reload_caches: loadSettings failed', err)),
    loadGames().catch((err) => logger.warn('admin.reload_caches: loadGames failed', err)),
    loadSocialFeeds().catch((err) => logger.warn('admin.reload_caches: loadSocialFeeds failed', err)),
  ])
  invalidateBotOwnerCache()

  return {
    ok: true,
    data: {
      reloaded: ['settings', 'games', 'social_feeds', 'bot_owner'],
    },
  }
}

registerVerb('admin.reload_caches', reloadCachesHandler)
