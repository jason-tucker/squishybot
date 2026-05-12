/**
 * Proof-of-life verb for the bot-side command bus.
 *
 * Botpanel sends `cmd.squishy.echo` with arbitrary `params`; the bot
 * replies with what it received plus a server timestamp so the panel can
 * verify end-to-end latency + that HMAC + replay-guard plumbing is wired.
 *
 * Importing this module registers the handler as a side effect — make
 * sure `src/index.ts` keeps the import so the registration fires before
 * any messages arrive.
 */
import { registerVerb, type VerbHandler } from '../registry'

export const echoHandler: VerbHandler = async (params, _ctx) => {
  return {
    ok: true,
    data: {
      you_said: params,
      server_ts: Date.now(),
    },
  }
}

registerVerb('echo', echoHandler)
