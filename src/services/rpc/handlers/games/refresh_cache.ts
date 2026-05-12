/**
 * `games.refresh_cache` — reload the bot's in-memory games catalog from the DB.
 *
 * Botpanel calls this verb after every games-table mutation (add/update/remove)
 * so the bot's `gamesCache` (the `catalog` Map populated by `loadGames()` in
 * `src/services/games.ts`) stays in sync with the DB without waiting for the
 * next bot restart. The DB writes themselves happen panel-side; this verb is
 * cache-invalidation only.
 *
 * Side-effect registration on import — see `src/bot/events/ready.ts` for the
 * import that wires this into the verb registry at boot.
 */
import { loadGames, gameCount } from '../../../games'
import { registerVerb, type VerbHandler } from '../../registry'

export const gamesRefreshCacheHandler: VerbHandler = async (_params, _ctx) => {
  await loadGames()
  return {
    ok: true,
    data: { gameCount: gameCount() },
  }
}

registerVerb('games.refresh_cache', gamesRefreshCacheHandler)
