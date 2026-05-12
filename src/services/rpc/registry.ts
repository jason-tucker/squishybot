/**
 * Verb registry for the bot-side command-bus subscriber.
 *
 * Follow-up PRs add handlers by importing `registerVerb` and calling it
 * once at module load. The registry is a plain `Map` — order doesn't
 * matter, and lookup is by exact verb name (the part after
 * `cmd.squishy.` in the channel).
 */
import type { Client } from 'discord.js'
import { logger } from '../logger'

export type VerbContext = {
  client: Client
  requestId: string
  ts: number
}

export type VerbResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string; details?: unknown }

export type VerbHandler = (params: unknown, ctx: VerbContext) => Promise<VerbResult>

const handlers = new Map<string, VerbHandler>()

/**
 * Register a handler for a verb. Last writer wins — log a warning so a
 * silent override (two modules both registering `voice.disconnect`) is
 * obvious at boot. Use a lazy import for the logger to keep this module
 * side-effect free for tests.
 */
export function registerVerb(verb: string, handler: VerbHandler): void {
  if (handlers.has(verb)) {
    logger.warn(`rpc: verb '${verb}' is being re-registered — last-writer wins`)
  }
  handlers.set(verb, handler)
}

export function getVerb(verb: string): VerbHandler | undefined {
  return handlers.get(verb)
}

export function listVerbs(): string[] {
  return Array.from(handlers.keys()).sort()
}
