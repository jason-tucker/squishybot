import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DmThrottle, dmThrottleKey, formatSuppressed } from '../src/services/dmThrottle'

const MIN = 60_000

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

test('dmThrottleKey: message plus the first line of the error', () => {
  const a = dmThrottleKey('Unhandled promise rejection', new Error('db down\nmore detail'))
  const b = dmThrottleKey('Unhandled promise rejection', new Error('db down\nother detail'))
  const c = dmThrottleKey('Unhandled promise rejection', new Error('timeout'))
  const d = dmThrottleKey('Uncaught exception', new Error('db down'))
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.notEqual(a, d)
  assert.equal(dmThrottleKey('x', 'plain\nstring'), dmThrottleKey('x', 'plain'))
  assert.equal(dmThrottleKey('x', undefined), dmThrottleKey('x', 'undefined'))
})

test('DmThrottle: one DM per key per 10 minute window', () => {
  const c = clock()
  const t = new DmThrottle({ now: c.now })
  assert.deepEqual(t.check('k'), { send: true, suppressed: 0 })
  assert.deepEqual(t.check('k'), { send: false })
  c.advance(10 * MIN - 1)
  assert.deepEqual(t.check('k'), { send: false })
  // a different key is independent
  assert.deepEqual(t.check('other'), { send: true, suppressed: 0 })
})

test('DmThrottle: reports how many were suppressed once the window reopens', () => {
  const c = clock()
  const t = new DmThrottle({ now: c.now })
  t.check('k')
  for (let i = 0; i < 49; i++) assert.equal(t.check('k').send, false)
  c.advance(10 * MIN)
  assert.deepEqual(t.check('k'), { send: true, suppressed: 49 })
  // count resets after it has been reported
  c.advance(10 * MIN)
  assert.deepEqual(t.check('k'), { send: true, suppressed: 0 })
})

test('DmThrottle: global cap of 10 DMs per hour across keys', () => {
  const c = clock()
  const t = new DmThrottle({ now: c.now })
  for (let i = 0; i < 10; i++) assert.equal(t.check(`k${i}`).send, true, `key ${i}`)
  assert.deepEqual(t.check('k10'), { send: false })
  assert.deepEqual(t.check('k10'), { send: false })
  c.advance(60 * MIN - 1)
  assert.deepEqual(t.check('k11'), { send: false })
  c.advance(1)
  // the hour has rolled; the capped key reports what it missed
  assert.deepEqual(t.check('k10'), { send: true, suppressed: 2 })
})

test('DmThrottle: key map stays bounded', () => {
  const c = clock()
  const t = new DmThrottle({ now: c.now, globalMax: Infinity, maxKeys: 50 })
  for (let i = 0; i < 500; i++) { t.check(`k${i}`); c.advance(1) }
  assert.ok(t.size() <= 51, `size ${t.size()}`)
})

test('formatSuppressed: suffix only when something was dropped', () => {
  assert.equal(formatSuppressed(0), '')
  assert.equal(formatSuppressed(3), '\n(+3 suppressed)')
})

test('DmThrottle: bypassGlobal (crash DM) is sent past the hourly cap, per-key window still applies', () => {
  const c = clock()
  const t = new DmThrottle({ now: c.now })
  for (let i = 0; i < 10; i++) t.check(`k${i}`)
  assert.deepEqual(t.check('normal'), { send: false })
  assert.deepEqual(t.check('crash', { bypassGlobal: true }), { send: true, suppressed: 0 })
  assert.deepEqual(t.check('crash', { bypassGlobal: true }), { send: false })
})

test('dmThrottleKey: non-Error objects key by content, circular values do not throw', () => {
  const a = dmThrottleKey('m', { code: 'ECONNREFUSED' })
  const b = dmThrottleKey('m', { code: 'ETIMEDOUT' })
  assert.notEqual(a, b)
  assert.equal(a, dmThrottleKey('m', { code: 'ECONNREFUSED' }))
  const circular: Record<string, unknown> = { name: 'loop' }
  circular.self = circular
  assert.equal(typeof dmThrottleKey('m', circular), 'string')
  assert.equal(dmThrottleKey('m', null), dmThrottleKey('m', 'null'))
  assert.equal(typeof dmThrottleKey('m', 10n), 'string')
})
