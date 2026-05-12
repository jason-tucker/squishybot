/**
 * Barrel for the Wave 7b hub-channel RPC verbs.
 *
 * Importing this module side-effects the `registerVerb(...)` calls in
 * each handler — `ready.ts` imports this file alongside the `echo`
 * import so all three verbs register before any commands can arrive.
 *
 * Verbs:
 *   - hub.lockdown      → per-hub lock / unlock
 *   - hub.lockdown_all  → guild-wide lock / unlock
 *   - hub.refresh_cache → reload in-memory hub cache after DB-only CRUD
 */
import './lockdown'
import './lockdownAll'
import './refreshCache'
