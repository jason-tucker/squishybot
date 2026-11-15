import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyDeleteError,
  createKeyedQueue,
  MAX_DELETE_ATTEMPTS,
  planDeleteRetry,
  planTransition,
  tryDeleteChannel,
} from '../src/services/voice/lifecycle'

// --- H1: a move must run the leave half before the join half ---

test('planTransition: move between managed rooms runs leave of A then join of B', () => {
  assert.deepEqual(planTransition('roomA', 'roomB'), [
    { kind: 'leave', channelId: 'roomA' },
    { kind: 'join', channelId: 'roomB' },
  ])
})

test('planTransition: move from a room into a hub still leaves the room first', () => {
  const steps = planTransition('roomA', 'hub1')
  assert.equal(steps[0]?.kind, 'leave')
  assert.equal(steps[0]?.channelId, 'roomA')
  assert.equal(steps[1]?.kind, 'join')
})

test('planTransition: plain join and plain leave', () => {
  assert.deepEqual(planTransition(null, 'roomB'), [{ kind: 'join', channelId: 'roomB' }])
  assert.deepEqual(planTransition('roomA', null), [{ kind: 'leave', channelId: 'roomA' }])
})

test('planTransition: same-channel update (mute, deafen) does nothing', () => {
  assert.deepEqual(planTransition('roomA', 'roomA'), [])
  assert.deepEqual(planTransition(null, null), [])
})

// --- M4: only Unknown Channel counts as already deleted ---

test('classifyDeleteError: 10003 Unknown Channel is gone', () => {
  assert.equal(classifyDeleteError({ code: 10003 }), 'gone')
})

test('classifyDeleteError: any other error keeps the row', () => {
  assert.equal(classifyDeleteError({ code: 50013 }), 'failed') // Missing Permissions
  assert.equal(classifyDeleteError({ code: 50001 }), 'failed') // Missing Access
  assert.equal(classifyDeleteError(new Error('ECONNRESET')), 'failed')
  assert.equal(classifyDeleteError({ code: '10003' }), 'failed')
  assert.equal(classifyDeleteError(null), 'failed')
  assert.equal(classifyDeleteError(undefined), 'failed')
})

test('tryDeleteChannel: success, already gone, and failure outcomes', async () => {
  const ok = await tryDeleteChannel({ delete: async () => undefined }, 'c1')
  assert.equal(ok.outcome, 'deleted')

  const gone = await tryDeleteChannel({ delete: async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }) } }, 'c1')
  assert.equal(gone.outcome, 'gone')

  const denied = Object.assign(new Error('Missing Permissions'), { code: 50013 })
  const failed = await tryDeleteChannel({ delete: async () => { throw denied } }, 'c1')
  assert.equal(failed.outcome, 'failed')
  assert.equal(failed.error, denied)
})

test('planDeleteRetry: retries up to the cap, then gives up', () => {
  assert.equal(MAX_DELETE_ATTEMPTS, 5)
  for (let attempt = 1; attempt < MAX_DELETE_ATTEMPTS; attempt++) {
    assert.equal(planDeleteRetry(attempt), 'retry')
  }
  assert.equal(planDeleteRetry(MAX_DELETE_ATTEMPTS), 'give_up')
})

// --- H1 follow-up: one member's voice events run strictly in order ---

const tick = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

test('createKeyedQueue: same key runs in submission order, never overlapping', async () => {
  const q = createKeyedQueue()
  const log: string[] = []
  const slow = q.run('member1', async () => { log.push('A start'); await tick(30); log.push('A end') })
  const fast = q.run('member1', async () => { log.push('B start'); log.push('B end') })
  await Promise.all([slow, fast])
  assert.deepEqual(log, ['A start', 'A end', 'B start', 'B end'])
})

test('createKeyedQueue: different keys run concurrently', async () => {
  const q = createKeyedQueue()
  const log: string[] = []
  const a = q.run('member1', async () => { await tick(30); log.push('m1') })
  const b = q.run('member2', async () => { log.push('m2') })
  await Promise.all([a, b])
  assert.deepEqual(log, ['m2', 'm1'])
})

test('createKeyedQueue: a rejected task reaches its caller and does not block the next', async () => {
  const q = createKeyedQueue()
  const failing = q.run('member1', async () => { throw new Error('boom') })
  const next = q.run('member1', async () => 'ran')
  await assert.rejects(failing, /boom/)
  assert.equal(await next, 'ran')
})

test('createKeyedQueue: drops the key once its queue drains', async () => {
  const q = createKeyedQueue()
  await q.run('member1', async () => {})
  await tick(0)
  assert.equal(q.pendingKeys(), 0)
})
