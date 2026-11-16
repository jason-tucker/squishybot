import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retryWithDelays, SETTINGS_LOAD_RETRY_DELAYS_MS } from '../src/services/cacheMerge'

test('boot schedule is 1s, 2s, 5s, 10s, 20s', () => {
  assert.deepEqual([...SETTINGS_LOAD_RETRY_DELAYS_MS], [1_000, 2_000, 5_000, 10_000, 20_000])
})

test('retryWithDelays waits the schedule then reports failure without throwing', async () => {
  const slept: number[] = []
  const retries: number[] = []
  let calls = 0
  const res = await retryWithDelays(
    async () => { calls++; throw new Error('db down') },
    SETTINGS_LOAD_RETRY_DELAYS_MS,
    { sleep: async ms => { slept.push(ms) }, onRetry: attempt => { retries.push(attempt) } },
  )
  assert.equal(res.ok, false)
  assert.equal(res.attempts, 6)
  assert.equal(calls, 6)
  assert.deepEqual(slept, [1_000, 2_000, 5_000, 10_000, 20_000])
  assert.deepEqual(retries, [1, 2, 3, 4, 5])
  if (!res.ok) assert.equal((res.error as Error).message, 'db down')
})

test('retryWithDelays stops at the first success', async () => {
  const slept: number[] = []
  let calls = 0
  const res = await retryWithDelays(
    async () => { calls++; if (calls < 3) throw new Error('x'); return 'loaded' },
    SETTINGS_LOAD_RETRY_DELAYS_MS,
    { sleep: async ms => { slept.push(ms) } },
  )
  assert.deepEqual(res, { ok: true, value: 'loaded', attempts: 3 })
  assert.deepEqual(slept, [1_000, 2_000])
})
