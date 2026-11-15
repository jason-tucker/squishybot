import { test } from 'node:test'
import assert from 'node:assert/strict'

// Harness smoke check: proves `pnpm test` runs TypeScript tests through tsx
// with Node's built-in runner (no extra test dependency).
test('test harness runs TypeScript', () => {
  const value: number = 1 + 1
  assert.equal(value, 2)
})
