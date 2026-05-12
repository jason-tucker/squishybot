/**
 * HMAC helpers for the botpanel ↔ bot command bus.
 *
 * Botpanel signs each request with `hmacSha256(BOTPANEL_RPC_SECRET, ...)`.
 * The bot recomputes the same digest and compares with a constant-time
 * check so a slow attacker can't probe valid digests byte-by-byte.
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
