/**
 * `hub.refresh_cache` verb — reload the in-memory hub cache from the DB.
 *
 * Called by the panel after a DB-only hub CRUD write (`/api/squishy/hubs`
 * routes) so the bot's hot-path `isHubChannelCached` lookup picks up the
 * change without waiting for the next `loadSettings()` (which only runs
 * at boot).
 *
 * Params: none — accepts an empty object or null. We don't take a
 * `channelId` filter because the cache rebuild is cheap (single small
 * SELECT) and a full refresh sidesteps any edge case where the panel
 * might add + remove rows in rapid succession.
 *
 * Returns `{ok: true, data: {hubCount}}`.
 */
import { registerVerb, type VerbHandler } from '../../registry'
import { reloadHubsCache } from '../../../settings'

export const hubRefreshCacheHandler: VerbHandler = async (_params, _ctx) => {
  const hubCount = await reloadHubsCache()
  return { ok: true, data: { hubCount } }
}

registerVerb('hub.refresh_cache', hubRefreshCacheHandler)
