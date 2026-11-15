import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { buildSignedReply, replySigningString, signReply } from '../src/utils/hmac'

// Shared vectors, computed with botpanel's own signReply (web/src/lib/botrpcReply.ts).
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef'
const REQ = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718'
const TS = 1763000000000

// Inline copy of the panel verifier (botrpcReply.ts verifyReply, requireSigned=true).
function panelVerify(parsed: unknown, secret: string, requestId: string, now: number): string {
  const isObj = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  if (!isObj || !Object.hasOwn(parsed as object, 'hmac')) return 'unsigned-required'
  const { ts, hmac, ...rest } = parsed as Record<string, unknown>
  if (typeof hmac !== 'string' || typeof ts !== 'number' || !Number.isFinite(ts)) return 'bad-signature-format'
  const msg = `res.${requestId}|${requestId}|${ts}|${JSON.stringify(rest)}`
  const expected = createHmac('sha256', secret).update(msg).digest('hex')
  const a = Buffer.from(hmac, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'bad-hmac'
  if (Math.abs(now - ts) > 30_000) return 'stale'
  return 'accept'
}

/** Publish + receive: stringify on the bot side, parse on the panel side. */
function wire(reply: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(reply))
}

const VECTORS: Array<[string, unknown, string]> = [
  ['A', { ok: true, data: { hidden: true, name: 'Café \u{1F3AE}', ids: ['123', '456'], '10': 'x', '2': 'y' } },
    '06f3bd391b553c232c7eed170607657a0026ba63704c154384a85520264df07c'],
  ['B', { ok: false, error: 'invalid-params', details: { step: 'channel', message: 'boom' } },
    '1b6d2742a2c83f1a59bbf423e86e30328ee455b7c15d0606b9e7ed4272299e84'],
  ['C', { ok: false, error: 'unknown-verb' },
    '7bfa09460de43914d02c69aa63ec8da00518def03676979fc9d3e3f15bb5ca1b'],
  ['D', { ok: false, error: 'handler-threw', details: undefined },
    '9db000d87a26aed67c046f9e1445e988b87c76c354235346bfb88f697622d09a'],
]

test('replySigningString: reply channel first, then requestId, ts, body', () => {
  assert.equal(replySigningString('r1', 5, '{"ok":true}'), 'res.r1|r1|5|{"ok":true}')
})

for (const [name, result, hmac] of VECTORS) {
  test(`vector ${name}: byte-exact hmac and accepted by the panel verifier`, () => {
    const signed = signReply(SECRET, REQ, result, TS)
    assert.equal(signed.hmac, hmac)
    assert.equal(signed.ts, TS)
    assert.deepEqual(buildSignedReply(SECRET, REQ, result, TS), signed)
    assert.equal(panelVerify(wire(signed), SECRET, REQ, TS), 'accept')
    assert.equal(panelVerify(wire(signed), SECRET, REQ, TS + 30_000), 'accept')
  })
}

test('vector A body: integer-like keys first, non-ASCII kept', () => {
  const { ts: _ts, hmac: _h, ...rest } = signReply(SECRET, REQ, VECTORS[0][1], TS)
  assert.equal(JSON.stringify(rest),
    '{"ok":true,"data":{"2":"y","10":"x","hidden":true,"name":"Café 🎮","ids":["123","456"]}}')
})

test('wire stays backward compatible: only ts and hmac are added', () => {
  const signed = signReply(SECRET, REQ, VECTORS[1][1], TS)
  assert.deepEqual(Object.keys(signed), ['ok', 'error', 'details', 'ts', 'hmac'])
  assert.match(signed.hmac as string, /^[0-9a-f]{64}$/)
})

test('panel rejects tampered data, wrong requestId, wrong secret, stale ts', () => {
  const signed = wire(signReply(SECRET, REQ, VECTORS[0][1], TS)) as Record<string, any>
  const tampered = structuredClone(signed)
  tampered.data.hidden = false
  assert.equal(panelVerify(tampered, SECRET, REQ, TS), 'bad-hmac')
  assert.equal(panelVerify({ ...signed, ok: false }, SECRET, REQ, TS), 'bad-hmac')
  assert.equal(panelVerify({ ...signed, ts: TS + 1 }, SECRET, REQ, TS), 'bad-hmac')
  assert.equal(panelVerify(signed, SECRET, REQ.replace(/^a/, 'b'), TS), 'bad-hmac')
  assert.equal(panelVerify(signed, `${SECRET}x`, REQ, TS), 'bad-hmac')
  assert.equal(panelVerify(signed, SECRET, REQ, TS + 30_001), 'stale')
  assert.equal(panelVerify(signed, SECRET, REQ, TS - 30_001), 'stale')
})

test('default ts is Date.now() as a number', () => {
  const before = Date.now()
  const signed = buildSignedReply(SECRET, REQ, { ok: true })
  assert.equal(typeof signed.ts, 'number')
  assert.ok((signed.ts as number) >= before && (signed.ts as number) <= Date.now())
  assert.equal(panelVerify(wire(signed), SECRET, REQ, Date.now()), 'accept')
})

const circular: Record<string, unknown> = { ok: true }
circular.self = circular

const UNSIGNABLE: Array<[string, unknown]> = [
  ['top-level ts', { ok: true, ts: 1 }],
  ['top-level hmac', { ok: true, hmac: 'x' }],
  ['array', [{ ok: true }]],
  ['null', null],
  ['undefined', undefined],
  ['string', 'ok'],
  ['BigInt', { ok: true, data: { n: 10n } }],
  ['circular', circular],
]

for (const [name, result] of UNSIGNABLE) {
  test(`unsignable result (${name}): signReply throws, buildSignedReply sends signed handler-threw`, () => {
    assert.throws(() => signReply(SECRET, REQ, result, TS))
    const reply = buildSignedReply(SECRET, REQ, result, TS)
    const { ts, hmac, ...rest } = reply
    assert.deepEqual(rest, { ok: false, error: 'handler-threw', details: 'reply-not-serializable' })
    assert.equal(ts, TS)
    assert.equal(typeof hmac, 'string')
    assert.equal(panelVerify(wire(reply), SECRET, REQ, TS), 'accept')
  })
}

test('nested Date / toJSON values normalize and verify', () => {
  const d = new Date('2026-11-14T00:00:00.000Z')
  const signed = signReply(SECRET, REQ, { ok: true, data: { at: d, x: { toJSON: () => 'X' } } }, TS)
  assert.deepEqual((signed.data as Record<string, unknown>), { at: '2026-11-14T00:00:00.000Z', x: 'X' })
  assert.equal(panelVerify(wire(signed), SECRET, REQ, TS), 'accept')
})

test('top-level class with toJSON normalizes and verifies', () => {
  class Reply {
    toJSON() { return { ok: true, data: 1 } }
  }
  const signed = signReply(SECRET, REQ, new Reply(), TS)
  assert.equal(signed.ok, true)
  assert.equal(panelVerify(wire(signed), SECRET, REQ, TS), 'accept')
})
