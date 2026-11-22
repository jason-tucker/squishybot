import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactUrl, redactSecrets, redisSecretPatterns, urlSecretPatterns, constructWithoutLeak, summarizeError } from '../src/utils/redact'

test('strips password only', () => {
  const out = redactUrl('redis://:s3cret@redis:6379')
  assert.equal(out, 'redis://redis:6379')
  assert.ok(!out.includes('s3cret'))
})

test('strips username and password', () => {
  const out = redactUrl('redis://admin:s3cret@redis:6379')
  assert.equal(out, 'redis://redis:6379')
  assert.ok(!out.includes('admin') && !out.includes('s3cret'))
})

test('keeps rediss scheme and db index', () => {
  assert.equal(redactUrl('rediss://u:p@cache.example.com:6380/2'), 'rediss://cache.example.com:6380/2')
})

test('url without credentials is unchanged', () => {
  assert.equal(redactUrl('redis://redis:6379'), 'redis://redis:6379')
})

test('IPv6 host', () => {
  assert.equal(redactUrl('redis://:pw@[::1]:6379/1'), 'redis://[::1]:6379/1')
})

test('URL-encoded password', () => {
  const out = redactUrl('redis://:p%40ss%2Fw%3Ard@redis:6379')
  assert.equal(out, 'redis://redis:6379')
  assert.ok(!out.includes('p%40ss') && !out.includes('p@ss'))
})

test('query string and fragment dropped', () => {
  assert.equal(redactUrl('redis://redis:6379/0?password=hunter2#frag'), 'redis://redis:6379/0')
})

test('invalid input is never echoed', () => {
  for (const bad of ['not a url hunter2', 'redis://:hunter2@', '://:hunter2@host', '', 'hunter2']) {
    const out = redactUrl(bad)
    assert.equal(out, '<invalid redis url>')
    assert.ok(!out.includes('hunter2'))
  }
  assert.equal(redactUrl(undefined), '<invalid redis url>')
})

test('password-free output for tricky inputs', () => {
  const cases: Array<[string, string]> = [
    ['redis://:p@ss@h:6379', 'redis://h:6379'],
    ['redis://default:1234/abcd@redis:6379', '<invalid redis url>'],
    ['redis://u:1234/ab@h:6379', '<invalid redis url>'],
    ['redis://h:6379/0 \n','redis://h:6379/0'],
    ['redis://h :6379 hunter2', '<invalid redis url>'],
    ['redis://h:6379/notadb', 'redis://h:6379'],
  ]
  for (const [input, expected] of cases) {
    const out = redactUrl(input)
    assert.equal(out, expected)
    for (const secret of ['ss', '1234', 'abcd', 'hunter2']) {
      if (expected !== input) assert.ok(!out.includes(secret), `${input} -> ${out}`)
    }
  }
  const long = 'redis://:' + 'x'.repeat(100000) + '@h:6379'
  assert.equal(redactUrl(long), 'redis://h:6379')
  assert.equal(redactUrl('x'.repeat(100000) + '@'), '<invalid redis url>')
})

test('redactSecrets scrubs REDIS_URL and decoded password', () => {
  const url = 'redis://:p%40ssw0rd%21@redis:6379'
  const pats = redisSecretPatterns(url)
  const out = redactSecrets(`conn ${url} and p@ssw0rd! and p%40ssw0rd%21`, pats)
  assert.ok(!out.includes('ssw0rd'), out)
  assert.ok(out.includes('[REDACTED:REDIS_URL]'))
  assert.deepEqual(redisSecretPatterns(undefined), [])
})

test('constructWithoutLeak never carries the original error', () => {
  const secret = 'redis://:hunter22222@h'
  assert.throws(
    () => constructWithoutLeak(() => { const e = new Error('Invalid URL') as Error & { input?: string }; e.input = secret; throw e }, 'x', secret),
    (e: Error & { input?: string }) => !e.message.includes('hunter2') && e.input === undefined,
  )
})

// Shaped like drizzle-orm 0.45's DrizzleQueryError wrapping a postgres.js PostgresError.
function fakeMigrationError(dbUrl: string): Error {
  const pg = Object.assign(new Error(`relation "auto_channels" already exists (seen via ${dbUrl})`), {
    name: 'PostgresError',
    code: '42P07',
    severity: 'ERROR',
    detail: `Key held by postgres://other:otherpw99@db2:5432/x`,
    hint: 'Drop the table first',
    position: '14',
    table_name: 'auto_channels',
    constraint_name: 'auto_channels_pkey',
    input: dbUrl,
  })
  const outer = new Error('Failed query: CREATE TABLE "auto_channels" ("id" text)\nparams: ') as Error & { query?: string; params?: unknown[]; cause?: unknown }
  outer.name = 'DrizzleQueryError'
  outer.query = 'CREATE TABLE "auto_channels" ("id" text)'
  outer.params = [dbUrl]
  outer.cause = pg
  return outer
}

test('summarizeError reports the cause chain with Postgres fields, scrubbed', () => {
  const dbUrl = 'postgres://squishy:s3cretpw777@db:5432/squishy'
  const out = summarizeError(fakeMigrationError(dbUrl), urlSecretPatterns(dbUrl, 'DATABASE'))
  assert.ok(out.includes('DrizzleQueryError'), out)
  assert.ok(out.includes('Failed query: CREATE TABLE'), out)
  assert.ok(out.includes('PostgresError'), out)
  assert.ok(out.includes('42P07'), out)
  assert.ok(out.includes('already exists'), out)
  assert.ok(out.includes('detail: '), out)
  assert.ok(out.includes('hint: Drop the table first'), out)
  assert.ok(out.includes('position: 14'), out)
  assert.ok(out.includes('table: auto_channels'), out)
  assert.ok(out.includes('constraint: auto_channels_pkey'), out)
  assert.ok(out.includes('[REDACTED:DATABASE_URL]'), out)
  for (const secret of ['s3cretpw777', 'otherpw99', 'squishy:', 'other:']) {
    assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`)
  }
})

test('summarizeError without known patterns still strips URL userinfo', () => {
  const out = summarizeError(fakeMigrationError('postgres://user:pw@host/db'), [])
  assert.ok(!out.includes('user:pw'), out)
  assert.ok(out.includes('postgres://[REDACTED]@host/db'), out)
})

test('summarizeError handles non-errors, cycles, depth and long messages', () => {
  assert.equal(summarizeError('boom', []), 'unknown error (string)')
  assert.equal(summarizeError(undefined, []), 'unknown error (undefined)')
  const a = new Error('a') as Error & { cause?: unknown }
  a.cause = a
  assert.equal(summarizeError(a, []).split('\n').filter((l) => l.includes('Error: a')).length, 1)
  let deep: Error & { cause?: unknown } = new Error('level5')
  for (let i = 4; i >= 0; i--) { const e = new Error(`level${i}`) as Error & { cause?: unknown }; e.cause = deep; deep = e }
  const d = summarizeError(deep, [])
  assert.ok(d.includes('level3') && !d.includes('level4'), d)
  const long = summarizeError(new Error('x'.repeat(10000)), [])
  assert.ok(long.length < 3000, String(long.length))
})

test('constructWithoutLeak message names the client kind and a non-redis placeholder', () => {
  const pgUrl = 'postgres://u:hunter22222@db:5432/app'
  assert.throws(
    () => constructWithoutLeak(() => { throw new Error(pgUrl) }, 'db', pgUrl, 'postgres'),
    (e: Error) => e.message === 'db: could not create postgres client for postgres://db:5432' && !e.message.includes('hunter2'),
  )
  assert.throws(
    () => constructWithoutLeak(() => { throw new Error('x') }, 'db', 'not a url hunter22222', 'postgres'),
    (e: Error) => e.message === 'db: could not create postgres client for <invalid postgres url>',
  )
  assert.throws(
    () => constructWithoutLeak(() => { throw new Error('x') }, 'eventBus', 'redis://:hunter22222@h:6379'),
    (e: Error) => e.message === 'eventBus: could not create redis client for redis://h:6379',
  )
})
