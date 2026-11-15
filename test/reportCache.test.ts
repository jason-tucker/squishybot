import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createReportSession,
  releaseReportSession,
  reportSessionState,
  restoreReportSession,
  takeReportSession,
} from '../src/services/reportCache'

// reportReview takes the session synchronously before any await, so a second
// click on the same review card finds nothing and cannot file a second issue.

function makeSession(): string {
  return createReportSession({
    reporterId: '1',
    reporterTag: 'reporter',
    title: 'title',
    body: 'body',
    labels: ['bug'],
  })
}

test('take twice gives the session, then undefined', () => {
  const key = makeSession()
  const first = takeReportSession(key)
  assert.ok(first)
  assert.equal(first.title, 'title')
  assert.equal(takeReportSession(key), undefined)
})

test('restore makes a taken session takeable again', () => {
  const key = makeSession()
  const taken = takeReportSession(key)
  assert.ok(taken)
  restoreReportSession(key, taken)
  assert.deepEqual(takeReportSession(key), taken)
  assert.equal(takeReportSession(key), undefined)
})

test('take of an unknown key is undefined', () => {
  assert.equal(takeReportSession('does-not-exist'), undefined)
})

test('a taken session is in flight until restored or released', () => {
  const key = makeSession()
  assert.equal(reportSessionState(key), 'available')
  const taken = takeReportSession(key)
  assert.ok(taken)
  assert.equal(reportSessionState(key), 'in-flight')
  restoreReportSession(key, taken)
  assert.equal(reportSessionState(key), 'available')
  assert.ok(takeReportSession(key))
  releaseReportSession(key)
  assert.equal(reportSessionState(key), 'handled')
  assert.equal(takeReportSession(key), undefined)
})

test('an unknown key reports unknown', () => {
  assert.equal(reportSessionState('never-created'), 'unknown')
})
