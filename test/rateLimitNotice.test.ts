import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  formatWait,
  MIN_NOTICE_MS,
  noteWait,
  noticeKey,
  pickNotice,
  pruneWaits,
  SEMANTIC_SCHOLAR_SOURCE,
} from '../src/modules/rateLimitNotice.core.ts'

const S2 = SEMANTIC_SCHOLAR_SOURCE

test('nothing waiting means no notice', () => {
  assert.equal(pickNotice({}, 1000, false), null)
})

test('a Semantic Scholar wait without a key carries the key hint', () => {
  const board = noteWait({}, S2, 1000, 31_000)
  assert.deepEqual(pickNotice(board, 1000, false), {
    id: 'rate-limit-waiting-semanticscholar-no-key',
    source: S2,
    amount: 30,
    unit: 'seconds',
  })
})

test('a Semantic Scholar wait with a key set does not suggest getting one', () => {
  const board = noteWait({}, S2, 1000, 31_000)
  assert.equal(pickNotice(board, 1000, true)?.id, 'rate-limit-waiting-semanticscholar')
})

test('other sources use the generic message, key or no key', () => {
  const board = noteWait({}, 'googlescholar', 1000, 61_000)
  assert.equal(pickNotice(board, 1000, false)?.id, 'rate-limit-waiting')
  assert.equal(pickNotice(board, 1000, false)?.source, 'googlescholar')
})

test('the notice counts down and goes away when the wait ends', () => {
  const board = noteWait({}, S2, 0, 10_000)
  assert.equal(pickNotice(board, 0, false)?.amount, 10)
  assert.equal(pickNotice(board, 5_500, false)?.amount, 5)
  assert.equal(pickNotice(board, 10_000, false), null)
  assert.equal(pickNotice(board, 20_000, false), null)
})

test('an announced wait stays announced to its last second', () => {
  // The queue is still blocked with half a second to go; the line must say so.
  const board = noteWait({}, S2, 0, 3_000)
  assert.deepEqual(pickNotice(board, 2_500, false)?.amount, 1)
  assert.equal(pickNotice(board, 2_999, false)?.amount, 1)
})

test('waits too short to read are not announced', () => {
  assert.equal(pickNotice(noteWait({}, S2, 0, MIN_NOTICE_MS - 1), 0, false), null)
  assert.notEqual(pickNotice(noteWait({}, S2, 0, MIN_NOTICE_MS), 0, false), null)
})

test('the longest wait is the one named', () => {
  let board = noteWait({}, S2, 0, 8_000)
  board = noteWait(board, 'googlescholar', 0, 60_000)
  assert.equal(pickNotice(board, 0, false)?.source, 'googlescholar')
})

test('a cleared wait is removed; the newest report replaces an older one', () => {
  let board = noteWait({}, S2, 0, 30_000)
  board = noteWait(board, S2, 1_000, 5_000)
  assert.deepEqual(board[S2], { sinceMs: 1_000, untilMs: 5_000 })
  board = noteWait(board, S2, 2_000, null)
  assert.deepEqual(board, {})
  assert.deepEqual(noteWait({}, 'x', 0, Number.NaN), {})
})

test('noteWait does not mutate the board it is given', () => {
  const board = noteWait({}, 'a', 0, 5_000)
  noteWait(board, 'b', 0, 6_000)
  noteWait(board, 'a', 0, null)
  assert.deepEqual(Object.keys(board), ['a'])
})

test('expired waits are pruned', () => {
  let board = noteWait({}, 'a', 0, 1_000)
  board = noteWait(board, 'b', 0, 5_000)
  assert.deepEqual(Object.keys(pruneWaits(board, 1_000)), ['b'])
})

test('waits round up, and long ones read in minutes', () => {
  assert.deepEqual(formatWait(100), { amount: 1, unit: 'seconds' })
  assert.deepEqual(formatWait(29_001), { amount: 30, unit: 'seconds' })
  assert.deepEqual(formatWait(119_999), { amount: 120, unit: 'seconds' })
  assert.deepEqual(formatWait(120_000), { amount: 2, unit: 'minutes' })
  assert.deepEqual(formatWait(150_000), { amount: 3, unit: 'minutes' })
})

test('the notice key changes with the text and is empty without a notice', () => {
  const board = noteWait({}, S2, 0, 10_000)
  assert.equal(noticeKey(null), '')
  assert.notEqual(noticeKey(pickNotice(board, 0, false)), noticeKey(pickNotice(board, 1_000, false)))
  assert.equal(noticeKey(pickNotice(board, 0, false)), noticeKey(pickNotice(board, 200, false)))
})
