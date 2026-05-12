/**
 * Side-effect aggregator for admin RPC verbs.
 *
 * Importing this module registers every admin verb on the registry. Keep
 * each verb's handler in its own file so the side-effect of registering
 * stays close to its implementation; this index just funnels the imports
 * so `bot/events/ready.ts` only has to add one line instead of one per
 * handler.
 *
 * Add a new admin verb? Drop a new file in this directory and re-export
 * it here (one line). The registry is dedupe-warned, so accidentally
 * importing twice is loud rather than silent.
 */
export * from './reloadCaches'
export * from './orphanScan'
export * from './reconcilerRun'
