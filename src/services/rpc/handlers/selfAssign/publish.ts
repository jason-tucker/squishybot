/**
 * `cmd.squishy.selfassign.publish` — wipe and repost every enabled board entry
 * in sort order. Use this after bulk changes or to repair a broken board.
 *
 * Params: (ignored)
 * Returns: { ok: true, data: { posted: number, removed: number, channelId: string|null } }
 */
import { registerVerb, type VerbHandler } from '../../registry'
import { publishBoard } from '../../../selfAssign'
import { env } from '../../../../config/env'

const publishHandler: VerbHandler = async (_params, ctx) => {
  const r = await publishBoard(ctx.client, env.GUILD_ID)
  return { ok: true, data: { posted: r.posted, removed: r.removed, channelId: r.channelId } }
}

registerVerb('selfassign.publish', publishHandler)
