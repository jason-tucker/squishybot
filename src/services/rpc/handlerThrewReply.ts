/**
 * Reply sent to the panel when a verb handler throws. `details` is a fixed
 * string on purpose: a thrown error's message can carry SQL text and bound
 * parameters (DrizzleQueryError) or other internals. The full error is
 * logged bot-side through the redacting logger instead.
 */
export const HANDLER_THREW_DETAILS = 'internal error'

export function handlerThrewReply(): { ok: false; error: 'handler-threw'; details: string } {
  return { ok: false, error: 'handler-threw', details: HANDLER_THREW_DETAILS }
}
