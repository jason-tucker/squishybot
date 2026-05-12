/**
 * `admin.reconciler_run` — re-run the voice reconciler on demand.
 *
 * Calls the existing `runReconciler(client)` from `src/services/voice/reconciler.ts`
 * — the same routine that runs on boot. Heavy op: walks every `auto_channels`
 * row, syncs perms, rebuilds control panels, etc., so the panel rate-limits
 * this hard (5/min/actor).
 *
 * Reply: `{ ok: true, data: { recovered, cleaned, hubs, panels, adopted } }`
 * — pass-through of `ReconcilerResult`. On reconciler throw we surface
 * `handler-threw` via the verb dispatcher's catch (we don't catch here so
 * the bot-side error log captures the stack).
 */
import { registerVerb, type VerbHandler } from '../../registry'
import { runReconciler } from '../../../voice/reconciler'

export const reconcilerRunHandler: VerbHandler = async (_params, ctx) => {
  const result = await runReconciler(ctx.client)
  return {
    ok: true,
    data: {
      recovered: result.recovered,
      cleaned: result.cleaned,
      hubs: result.hubs,
      panels: result.panels,
      adopted: result.adopted,
    },
  }
}

registerVerb('admin.reconciler_run', reconcilerRunHandler)
