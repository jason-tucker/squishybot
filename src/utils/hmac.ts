/**
 * HMAC helpers for the botpanel ↔ bot command bus.
 *
 * Botpanel signs each request with `hmacSha256(BOTPANEL_RPC_SECRET, ...)`.
 * The bot recomputes the same digest and compares with a constant-time
 * check so a slow attacker can't probe valid digests byte-by-byte.
 * Replies are signed the same way (`signReply` / `buildSignedReply`).
 */
import crypto from 'node:crypto'

/**
 * SHA-256 HMAC, hex-encoded. Wraps `crypto.createHmac` so the call sites
 * stay readable and we have one obvious spot to swap the algorithm if the
 * panel ever rotates.
 */
export function hmacSha256(secret: string, message: string): string {
  return crypto.createHmac('sha256', secret).update(message).digest('hex')
}

/**
 * Constant-time equality for two hex digests. `crypto.timingSafeEqual`
 * throws on length mismatch — we length-check first so an attacker can't
 * use the throw vs. return path as an oracle.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
  } catch {
    return false
  }
}

/**
 * String the panel verifies a reply against (botpanel `botrpcReply.ts`):
 * `res.${requestId}|${requestId}|${ts}|${body}`. The first field is the
 * reply channel name; `ts` is epoch ms (a number, not ISO).
 */
export function replySigningString(requestId: string, ts: number, body: string): string {
  return `res.${requestId}|${requestId}|${ts}|${body}`
}

/**
 * Sign an RPC reply: returns `{...result, ts, hmac}` ready to publish on
 * `res.<requestId>`. The panel strips `ts`/`hmac`, re-stringifies the rest
 * and recomputes the HMAC, so we sign over the JSON round-trip of `result`
 * (drops `undefined`, applies `toJSON`) to sign exactly what it will see.
 *
 * Throws when `result` cannot be serialized (BigInt, circular), is not a
 * plain non-array object after normalization, or already has a top-level
 * `ts` or `hmac` key (the panel would strip it and fail the check).
 */
export function signReply(
  secret: string,
  requestId: string,
  result: unknown,
  ts: number = Date.now(),
): Record<string, unknown> {
  const json = JSON.stringify(result)
  if (typeof json !== 'string') throw new Error('reply is not serializable')
  const normalized: unknown = JSON.parse(json)
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error('reply must be a plain object')
  }
  if (Object.hasOwn(normalized, 'ts') || Object.hasOwn(normalized, 'hmac')) {
    throw new Error('reply must not have a top-level ts or hmac key')
  }
  const obj = normalized as Record<string, unknown>
  const body = JSON.stringify(obj)
  return { ...obj, ts, hmac: hmacSha256(secret, replySigningString(requestId, ts, body)) }
}

/**
 * Like `signReply`, but never throws: an unsignable result becomes a signed
 * `{ ok: false, error: 'handler-threw', details: 'reply-not-serializable' }`.
 */
export function buildSignedReply(
  secret: string,
  requestId: string,
  result: unknown,
  ts: number = Date.now(),
): Record<string, unknown> {
  try {
    return signReply(secret, requestId, result, ts)
  } catch {
    return signReply(secret, requestId, { ok: false, error: 'handler-threw', details: 'reply-not-serializable' }, ts)
  }
}
