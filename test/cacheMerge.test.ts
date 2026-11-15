import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createReloadTracker,
  mergeMapSnapshot,
  mergeSetSnapshot,
  touchTrackers,
  type ReloadTracker,
} from '../src/services/cacheMerge'

// Models settings.ts: a reload registers a tracker before its queries, the
// mutators touch every active tracker after changing the live cache, and the
// swap merges the (stale) snapshot with the touched keys.

test('track/untrack during an in-flight reload survive the swap', () => {
  const textIds = new Set(['oldText', 'goneText'])
  const voiceMap = new Map([['oldVoice', 'oldText'], ['goneVoice', 'goneText']])
  const active = new Set<ReloadTracker>()
  const tracker = createReloadTracker()
  active.add(tracker)

  // Snapshot read before the mutations below committed.
  const snapText = new Set(['oldText', 'goneText'])
  const snapVoice = new Map([['oldVoice', 'oldText'], ['goneVoice', 'goneText']])

  // createAutoChannel: track the new pair.
  textIds.add('newText'); touchTrackers(active, 'autoText', 'newText')
  voiceMap.set('newVoice', 'newText'); touchTrackers(active, 'autoVoice', 'newVoice')
  // deleteAutoChannel: untrack the gone pair.
  textIds.delete('goneText'); touchTrackers(active, 'autoText', 'goneText')
  voiceMap.delete('goneVoice'); touchTrackers(active, 'autoVoice', 'goneVoice')

  mergeSetSnapshot(textIds, snapText, tracker.autoText)
  mergeMapSnapshot(voiceMap, snapVoice, tracker.autoVoice)
  active.delete(tracker)

  assert.deepEqual([...textIds].sort(), ['newText', 'oldText'])
  assert.deepEqual([...voiceMap.entries()].sort(), [['newVoice', 'newText'], ['oldVoice', 'oldText']])
})

test('hub id swap during an in-flight reload survives a snapshot holding the old id', () => {
  const hubs = new Map([['hubOld', { id: 'h1', channelId: 'hubOld' }]])
  const active = new Set<ReloadTracker>()
  const tracker = createReloadTracker()
  active.add(tracker)
  // Snapshot read before the hub_channels UPDATE committed.
  const snap = new Map([['hubOld', { id: 'h1', channelId: 'hubOld' }]])

  // updateHubChannelId(old, new): touches both ids.
  const hub = hubs.get('hubOld')!
  hubs.delete('hubOld')
  hubs.set('hubNew', { ...hub, channelId: 'hubNew' })
  touchTrackers(active, 'hubs', 'hubOld')
  touchTrackers(active, 'hubs', 'hubNew')

  mergeMapSnapshot(hubs, snap, tracker.hubs)

  assert.equal(hubs.has('hubOld'), false)
  assert.deepEqual(hubs.get('hubNew'), { id: 'h1', channelId: 'hubNew' })
})

test('setSetting and clearSetting during an in-flight reload survive the swap', () => {
  const settings = new Map([['a', '1'], ['b', '2']])
  const active = new Set<ReloadTracker>()
  const tracker = createReloadTracker()
  active.add(tracker)
  const snap = new Map([['a', '1'], ['b', '2']])

  settings.set('a', 'live'); touchTrackers(active, 'settings', 'a')
  settings.delete('b'); touchTrackers(active, 'settings', 'b')
  settings.set('c', 'new'); touchTrackers(active, 'settings', 'c')

  mergeMapSnapshot(settings, snap, tracker.settings)
  assert.deepEqual(Object.fromEntries(settings), { a: 'live', c: 'new' })
})

test('untouched keys follow the snapshot (panel edits and deletions land)', () => {
  const settings = new Map([['keep', 'old'], ['removedInDb', 'x'], ['touched', 'live']])
  const snap = new Map([['keep', 'panelValue'], ['addedInDb', 'y'], ['touched', 'stale']])
  mergeMapSnapshot(settings, snap, new Set(['touched']))
  assert.deepEqual(Object.fromEntries(settings), { keep: 'panelValue', addedInDb: 'y', touched: 'live' })

  const sudo = new Set(['u1', 'u2'])
  mergeSetSnapshot(sudo, new Set(['u2', 'u3']), new Set())
  assert.deepEqual([...sudo].sort(), ['u2', 'u3'])
})

test('a mutation touches only active trackers; a later reload is unaffected', () => {
  const active = new Set<ReloadTracker>()
  const first = createReloadTracker()
  active.add(first)
  touchTrackers(active, 'sudo', 'u1')
  active.delete(first)
  const second = createReloadTracker()
  active.add(second)
  touchTrackers(active, 'sudo', 'u2')
  assert.deepEqual([...first.sudo], ['u1'])
  assert.deepEqual([...second.sudo], ['u2'])
  assert.equal(second.settings.size, 0)
})
