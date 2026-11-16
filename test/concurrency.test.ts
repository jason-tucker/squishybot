import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSingleFlight, createTimerSlots } from '../src/utils/concurrency'
import { HANDLER_THREW_DETAILS, handlerThrewReply } from '../src/services/rpc/handlerThrewReply'

// --- single-flight (reconciler re-entry guard) ---

test('createSingleFlight: concurrent callers share one run and one result', async () => {
  let calls = 0
  let release!: (v: number) => void
  const run = createSingleFlight(() => {
    calls++
    return new Promise<number>(resolve => { release = resolve })
  })
  const a = run()
  const b = run()
  assert.equal(a, b, 'second caller gets the same promise')
  release(42)
  assert.deepEqual(await Promise.all([a, b]), [42, 42])
  assert.equal(calls, 1)
})

test('createSingleFlight: a call after settle starts a fresh run', async () => {
  let calls = 0
  const run = createSingleFlight(async () => ++calls)
  assert.equal(await run(), 1)
  assert.equal(await run(), 2)
})

test('createSingleFlight: a rejection is shared and does not wedge later calls', async () => {
  let calls = 0
  const run = createSingleFlight(async () => {
    calls++
    if (calls === 1) throw new Error('boom')
    return 'ok'
  })
  const a = run()
  const b = run()
  await assert.rejects(a, /boom/)
  await assert.rejects(b, /boom/)
  assert.equal(await run(), 'ok')
  assert.equal(calls, 2)
})

test('createSingleFlight: a synchronous throw becomes a rejection and clears the slot', async () => {
  let calls = 0
  const run = createSingleFlight((): Promise<string> => {
    calls++
    if (calls === 1) throw new Error('sync')
    return Promise.resolve('ok')
  })
  await assert.rejects(run(), /sync/)
  assert.equal(await run(), 'ok')
})

// --- timer slots (cleanup scheduler reservation) ---

test('createTimerSlots: a reserved key refuses a second reservation (no second timer)', async () => {
  const slots = createTimerSlots()
  const t1 = slots.reserve('vc1')
  assert.ok(t1)
  // Simulate the await between the check and setTimeout in scheduleCleanup.
  await Promise.resolve()
  assert.equal(slots.reserve('vc1'), null, 'second concurrent schedule is rejected')
  const timer = setTimeout(() => {}, 10_000)
  assert.equal(slots.commit('vc1', t1, timer), true)
  assert.equal(slots.reserve('vc1'), null, 'armed key still refuses')
  // The single armed timer is cancellable.
  assert.equal(slots.cancel('vc1'), true)
  assert.equal(slots.has('vc1'), false)
})

test('createTimerSlots: cancel during the reservation makes commit refuse', () => {
  const slots = createTimerSlots()
  const t1 = slots.reserve('vc1')!
  assert.equal(slots.holds('vc1', t1), true)
  assert.equal(slots.cancel('vc1'), false, 'nothing armed yet')
  assert.equal(slots.holds('vc1', t1), false)
  const t2 = slots.reserve('vc1')!
  assert.equal(slots.holds('vc1', t1), false, 'a newer reservation does not revive the old one')
  slots.release('vc1', t2)
  const timer = setTimeout(() => {}, 10_000)
  assert.equal(slots.commit('vc1', t1, timer), false, 'stale reservation cannot arm a timer')
  clearTimeout(timer)
  assert.equal(slots.has('vc1'), false)
})

test('createTimerSlots: release frees a reservation; a stale token cannot release a newer one', () => {
  const slots = createTimerSlots()
  const t1 = slots.reserve('vc1')!
  slots.release('vc1', t1)
  assert.equal(slots.has('vc1'), false)
  const t2 = slots.reserve('vc1')!
  slots.release('vc1', t1)
  assert.equal(slots.has('vc1'), true, 'old token does not free the new reservation')
  slots.release('vc1', t2)
  assert.equal(slots.has('vc1'), false)
})

test('createTimerSlots: fired removes only the matching timer; set replaces and clears an old one', () => {
  const slots = createTimerSlots()
  const old = setTimeout(() => { assert.fail('replaced timer must be cleared') }, 5)
  slots.set('vc1', old)
  const next = setTimeout(() => {}, 10_000)
  slots.set('vc1', next)
  slots.fired('vc1', old)
  assert.equal(slots.has('vc1'), true, 'stale fire does not drop the live timer')
  slots.fired('vc1', next)
  assert.equal(slots.has('vc1'), false)
  clearTimeout(next)
})

// --- RPC handler-threw fallback ---

test('handlerThrewReply: details is fixed and never carries the error message', () => {
  const reply = handlerThrewReply()
  assert.deepEqual(reply, { ok: false, error: 'handler-threw', details: 'internal error' })
  assert.equal(HANDLER_THREW_DETAILS, 'internal error')
  assert.equal(handlerThrewReply().details, reply.details)
})
